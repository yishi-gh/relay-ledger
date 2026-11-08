#!/usr/bin/env node
/**
 * 采集接收器：接收 Tampermonkey 脚本 POST 的 capture JSON，
 * 与本地 accounts.capture.json 合并后原子写回同一个文件。
 *
 * 用法：
 *   node v2/tools/capture-receiver.mjs
 *   node v2/tools/capture-receiver.mjs --port 8799 --file v2/secrets/accounts.capture.json
 *   RELAY_LEDGER_CAPTURE_TOKEN=<TOKEN> node v2/tools/capture-receiver.mjs
 *
 * 只监听本机回环地址，不提供 CORS，不记录请求内容。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(SCRIPT_DIR, '..', 'secrets', 'accounts.capture.json');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8799;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const SERVICE = 'relay-ledger-capture-receiver';

function createLogger(logger) {
  if (typeof logger === 'function') return { info: logger, error: logger };
  return {
    info: (message) => logger?.info?.(message),
    error: (message) => (logger?.error ?? logger?.info)?.(message),
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, code, message, extraHeaders) {
  sendJson(res, status, { ok: false, error: code, message }, extraHeaders);
}

/** 常量时间比较，避免按长度或前缀泄露 token */
function sameSecret(provided, expected) {
  const left = crypto.createHash('sha256').update(String(provided ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function textField(account, field) {
  const value = account?.[field];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * 合并键，与采集脚本（capture.user.js 的 mergeKey）保持一致：
 * site_url + account.id > name > email；都没有时退回站点级兜底键。
 */
export function mergeKey(entry) {
  const site = typeof entry?.site_url === 'string' ? entry.site_url.trim() : '';
  const account = entry?.account && typeof entry.account === 'object' ? entry.account : {};
  const id = textField(account, 'id');
  const name = textField(account, 'name');
  const email = textField(account, 'email');
  if (entry?.identity_source === 'site_fallback') {
    return `${site}|site_fallback|${id || name || email || textField(entry, 'auth_fingerprint') || 'no-fingerprint'}`.toLowerCase();
  }
  if (id) return `${site}|account|${id}`.toLowerCase();
  if (name) return `${site}|account|${name}`.toLowerCase();
  if (email) return `${site}|account|${email}`.toLowerCase();
  const fallback = textField(entry, 'auth_fingerprint') || 'no-fingerprint';
  return `${site}|site_fallback|${fallback}`.toLowerCase();
}

/** captured_at 解析为毫秒时间戳；无法解析视为最旧 */
export function capturedAt(entry) {
  const value = entry?.captured_at;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function invalidPayload(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'invalid_payload';
  return err;
}

/** 接受 {schema_version, accounts:[...]} 或单个账户对象 */
export function normalizePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidPayload('请求体必须是 JSON 对象或包含 accounts 数组的对象');
  }
  if (body.schema_version !== undefined && body.schema_version !== SCHEMA_VERSION) {
    throw invalidPayload(`schema_version 只支持 ${SCHEMA_VERSION}`);
  }

  let entries;
  if (Array.isArray(body.accounts)) {
    entries = body.accounts;
  } else if (typeof body.site_url === 'string') {
    entries = [body];
  } else {
    throw invalidPayload('请求体缺少 accounts 数组，也不像单个账户对象');
  }

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidPayload(`accounts[${index}] 不是对象`);
    }
    if (typeof entry.site_url !== 'string' || !entry.site_url.trim()) {
      throw invalidPayload(`accounts[${index}].site_url 缺失`);
    }
  });
  return entries;
}

/** 合并进 accounts 数组；返回计数，未知字段原样保留 */
export function mergeEntries(accounts, incoming) {
  const index = new Map();
  accounts.forEach((entry, position) => index.set(mergeKey(entry), position));

  let added = 0;
  let updated = 0;
  for (const entry of incoming) {
    const key = mergeKey(entry);
    const position = index.get(key);
    if (position === undefined) {
      index.set(key, accounts.length);
      accounts.push(entry);
      added += 1;
      continue;
    }
    if (capturedAt(accounts[position]) > capturedAt(entry)) continue;
    accounts[position] = entry;
    updated += 1;
  }
  return { added, updated, total: accounts.length };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 超限后丢弃后续数据但继续读完，保证 413 能正常返回给客户端
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooLarge, buffer: tooLarge ? null : Buffer.concat(chunks) }));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}

async function readExisting(file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!text.trim()) return null;

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error('现有采集文件不是合法 JSON，拒绝覆盖');
    err.status = 409;
    err.code = 'file_invalid';
    throw err;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Array.isArray(json.accounts)) {
    const err = new Error('现有采集文件结构不支持，拒绝覆盖');
    err.status = 409;
    err.code = 'file_invalid';
    throw err;
  }
  return json;
}

/** 同目录临时文件 + rename 原子替换；POSIX 0600，Windows 尽力 */
async function writeAtomic(file, json) {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const payload = `${JSON.stringify(json, null, 2)}\n`;

  let handle;
  try {
    handle = await fs.promises.open(tmp, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    handle = null;
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();

  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  try {
    await fs.promises.chmod(file, 0o600);
  } catch {
    // Windows 上 chmod 只影响只读标记，失败不影响写入结果
  }
}

/**
 * 创建接收器（不自动 listen，便于测试用 port 0）。
 * @returns {{server: import('node:http').Server, start: () => Promise<any>, close: () => Promise<void>, address: () => any}}
 */
export function createCaptureReceiver({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  file = DEFAULT_FILE,
  token = '',
  logger = console,
} = {}) {
  const log = createLogger(logger);
  const targetFile = path.resolve(file);
  const fileName = path.basename(targetFile);
  const sharedToken = typeof token === 'string' ? token.trim() : '';

  let queue = Promise.resolve();
  /** 合并与写入串行化，避免并发请求互相覆盖 */
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.then(() => {}, () => {});
    return result;
  }

  async function handleCapture(req, res) {
    if (req.headers['x-relay-ledger-capture'] !== '1') {
      sendError(res, 403, 'capture_header_required', '缺少 X-Relay-Ledger-Capture: 1');
      return;
    }
    if (sharedToken && !sameSecret(req.headers['x-relay-ledger-token'], sharedToken)) {
      sendError(res, 401, 'unauthorized', 'token 缺失或不匹配');
      return;
    }

    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendError(res, 415, 'unsupported_media_type', 'Content-Type 必须是 application/json');
      return;
    }

    const { tooLarge, buffer } = await readBody(req, MAX_BODY_BYTES);
    if (tooLarge) {
      sendError(res, 413, 'payload_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`, { Connection: 'close' });
      return;
    }

    let body;
    try {
      body = JSON.parse(buffer.toString('utf8'));
    } catch {
      sendError(res, 400, 'invalid_json', '请求体不是合法 JSON');
      return;
    }

    let entries;
    try {
      entries = normalizePayload(body);
    } catch (err) {
      sendError(res, err.status ?? 400, err.code ?? 'invalid_payload', err.message);
      return;
    }

    await enqueue(async () => {
      try {
        const existing = await readExisting(targetFile);
        const json = existing ?? { schema_version: SCHEMA_VERSION, accounts: [] };
        const accounts = json.accounts;
        const counts = mergeEntries(accounts, entries);

        await writeAtomic(targetFile, {
          ...json,
          schema_version: SCHEMA_VERSION,
          captured_at: Date.now(),
          accounts,
        });

        log.info(`采集接收器: +${counts.added} 新增 / ~${counts.updated} 更新 / 共 ${counts.total} 条`);
        sendJson(res, 200, { ok: true, ...counts, file: fileName });
      } catch (err) {
        if (err.status === 409) {
          log.error(`采集接收器: ${fileName} 无法解析，本次写入被拒绝`);
          sendError(res, 409, err.code, err.message);
          return;
        }
        log.error(`采集接收器: 写入失败 ${err.code ?? err.message}`);
        sendError(res, 500, 'write_failed', '写入采集文件失败');
      }
    });
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      sendError(res, 400, 'bad_request', '无法解析请求路径');
      return;
    }

    if (url.pathname === '/health') {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: SERVICE, version: 1 });
        return;
      }
      sendError(res, 405, 'method_not_allowed', '只支持 GET /health', { Allow: 'GET' });
      return;
    }

    if (url.pathname === '/capture') {
      if (req.method === 'POST') {
        await handleCapture(req, res);
        return;
      }
      // 含 OPTIONS：不回应预检，普通网页无法跨域提交
      sendError(res, 405, 'method_not_allowed', '只支持 POST /capture', { Allow: 'POST' });
      return;
    }

    sendError(res, 404, 'not_found', '未知路径');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`采集接收器: 请求处理失败 ${err.code ?? err.message}`);
      sendError(res, 500, 'internal_error', '请求处理失败');
    });
  });

  async function start() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const address = server.address();
    log.info(`采集接收器已启动 http://${host}:${address.port} → ${targetFile}`);
    return address;
  }

  async function close() {
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    log.info('采集接收器已停止');
  }

  function address() {
    return server.address();
  }

  return { server, start, close, address };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    file: DEFAULT_FILE,
    token: process.env.RELAY_LEDGER_CAPTURE_TOKEN ?? '',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--port' || arg === '-p') {
      opts.port = Number.parseInt(argv[++i] ?? '', 10);
    } else if (arg.startsWith('--port=')) {
      opts.port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--file' || arg === '-f') {
      opts.file = argv[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      opts.file = arg.slice('--file='.length);
    } else if (arg === '--token' || arg === '-t') {
      opts.token = argv[++i] ?? '';
    } else if (arg.startsWith('--token=')) {
      opts.token = arg.slice('--token='.length);
    } else {
      throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error('端口必须是 1..65535 的整数');
  }
  if (!opts.file.trim()) throw new Error('--file 不能为空');
  return opts;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (process.platform === 'win32') {
    return path.resolve(entry).toLowerCase() === self.toLowerCase();
  }
  return path.resolve(entry) === self;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    console.log(`用法: node v2/tools/capture-receiver.mjs [选项]

  --port, -p <端口>    监听端口，默认 ${DEFAULT_PORT}（仅 127.0.0.1）
  --file, -f <路径>    采集文件，默认 ${DEFAULT_FILE}
  --token, -t <token>  可选访问令牌，也可用环境变量 RELAY_LEDGER_CAPTURE_TOKEN
  --help, -h           显示本帮助`);
    return;
  }

  const receiver = createCaptureReceiver({
    host: DEFAULT_HOST,
    port: opts.port,
    file: opts.file,
    token: opts.token,
  });

  try {
    await receiver.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${opts.port} 已被占用，换一个 --port 或先停掉旧进程`);
    } else {
      console.error(`启动失败: ${err.code ?? err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const shutdown = () => {
    receiver.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isMainModule()) {
  await main();
}

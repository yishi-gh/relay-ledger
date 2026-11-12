#!/usr/bin/env node
/**
 * v2 本地预览服务：只读站点库，静态服务 frontend/dist，API 见 v2/CONTRACT.md。
 *
 * 用法：
 *   node v2/server.mjs
 *   node v2/server.mjs --port=8790
 *   PORT=8790 node v2/server.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createApi } from './lib/api.mjs';
import { loadConfig, resolveConfigFile } from './lib/config.mjs';
import { ensureDataDirs, INSTANCE, INSTANCE_FILE } from './lib/instance.mjs';
import {
  createRuntimeSettingsStore,
  RevisionConflictError,
  RuntimeSettingsError,
  SHARED_DEFAULTS,
} from './lib/runtime-settings.mjs';
import { buildServiceHealth } from './lib/service-health.mjs';
import { createSiteLogoService } from './lib/site-logos.mjs';
import { openDashboardDb, syncAccounts } from './store/dashboard.mjs';
import { ensureAggIndexes, LOGS_SCHEMA } from './store/site-logs.mjs';

const V2_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(V2_DIR, '..');
const WEB_DIR = path.join(ROOT, 'frontend', 'dist');
const DASHBOARD_FILE = INSTANCE.paths.dashboardFile;

/** 未带内容 hash 的前端文件不做强缓存：本地改完刷新就能生效 */
const NO_CACHE_EXT = new Set(['.html', '.js', '.mjs', '.css']);

/** Vite 默认产物名为 name-<8 位内容 hash>.ext；未带 hash 的文件不做不可变缓存 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function isImmutableAsset(pathname) {
  return /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(pathname);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function parseArgs(argv) {
  const opts = {
    port: Number.parseInt(process.env.PORT ?? '', 10) || 8788,
    host: process.env.HOST || '127.0.0.1',
    site: process.env.SITE || INSTANCE.site.id,
    source: null,
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
    } else if (arg === '--host') {
      opts.host = argv[++i] ?? opts.host;
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.slice('--host='.length);
    } else if (arg === '--site') {
      opts.site = argv[++i] ?? opts.site;
    } else if (arg.startsWith('--site=')) {
      opts.site = arg.slice('--site='.length);
    } else if (arg === '--source') {
      opts.source = argv[++i] ?? null;
    } else if (arg.startsWith('--source=')) {
      opts.source = arg.slice('--source='.length);
    } else if (arg === '--config') {
      // 配置文件已在 lib/instance.mjs 初始化时读取，这里只吞掉参数不报错
      i += 1;
    } else if (arg.startsWith('--config=')) {
      // 同上
    } else {
      throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error('端口必须是 1..65535 的整数');
  }
  return opts;
}

// 站点库单行约 3 KB，聚合查询要回表读大量页；磁盘只有几 MB/s 时这层随机读
// 比 SQL 本身更贵。把库文件映射进内存后 overview 约 3 倍提升，代价是常驻 RSS
// 随访问页增长（280 MB 的库实测 50 MB → 178 MB）。
const MMAP_BYTES = 256 * 1024 * 1024;

/**
 * 打开只读源库。库文件不存在时先按采集器的表结构建一个空库，让面板以「暂无数据」
 * 启动——首次部署往往还没跑过采集，直接抛错会把「上去看一眼」变成「先跑命令行」。
 */
export function openSourceDb(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const created = new DatabaseSync(resolved);
    created.exec(LOGS_SCHEMA);
    ensureAggIndexes(created);
    created.close();
    console.warn(`[v2] 源库不存在，已创建空库：${resolved}（等待采集器写入）`);
  }
  // 只读打开：不建表、不写 PRAGMA、不留 -wal
  const db = new DatabaseSync(resolved, { readOnly: true });
  // 连接级设置，不落盘，也不改变库文件
  db.exec(`PRAGMA mmap_size = ${MMAP_BYTES}`);
  return db;
}

function sendJson(res, status, body, options = {}) {
  sendPayload(res, status, JSON.stringify(body), options);
}

function sendPayload(res, status, payload, { head = false, headers = {} } = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(head ? undefined : payload);
}

function sendError(res, status, code, message, { head = false } = {}) {
  sendJson(res, status, { error: { code, message } }, { head });
}

function sendText(res, status, text, { head = false } = {}) {
  const payload = `${text}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : payload);
}

/** 图标是二进制资源：直接写 body，不走 JSON 包装，也不进 API cache */
const LOGO_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};

function sendLogo(res, logo, { head = false } = {}) {
  res.writeHead(200, {
    'Content-Type': logo.contentType,
    'Content-Length': logo.body.length,
    'Cache-Control': 'private, max-age=86400',
    ...LOGO_SECURITY_HEADERS,
  });
  res.end(head ? undefined : logo.body);
}

function sendLogoMiss(res, { head = false } = {}) {
  const payload = JSON.stringify({ error: { code: 'not_found', message: '未找到站点图标' } });
  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'private, max-age=21600',
    ...LOGO_SECURITY_HEADERS,
  });
  res.end(head ? undefined : payload);
}

/** 日志里的路径：仓库内显示相对路径，仓库外显示绝对路径（线上数据目录可能在 /var 下） */
function displayPath(file) {
  const abs = path.resolve(file);
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

/** 把 URL 路径安全地拼到 root 下；越界或非法编码返回 null */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, `.${path.posix.normalize(`/${decoded}`)}`);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null;
  return target;
}

function serveFile(res, file, { head = false, status = 200, immutable = false } = {}) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(status, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : immutable
      ? IMMUTABLE_CACHE
      : NO_CACHE_EXT.has(ext) ? 'no-cache' : 'public, max-age=300',
  });
  if (head) {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveStatic(res, pathname, { head, webDir }) {
  let rel = pathname.slice(1);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = safeJoin(webDir, rel);
  if (!file) return sendError(res, 400, 'bad_path', '非法路径', { head });

  try {
    if (serveFile(res, file, { head, immutable: isImmutableAsset(pathname) })) return undefined;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && err.code !== 'ENOTDIR') throw err;
  }
  if (pathname === '/' || pathname === '/index.html') {
    return sendText(res, 503,
      'frontend/dist/index.html 不存在，请先运行 npm --prefix frontend ci，然后运行 npm --prefix frontend run build',
      { head });
  }
  return sendText(res, 404, 'Not Found', { head });
}

/** 前端要显示的站点名与上游地址来自实例配置，不在 api 层再解析一次 */
function metaOf(api) {
  return {
    ...api.meta(),
    site_name: INSTANCE.site.name,
    base_url: INSTANCE.site.base_url,
  };
}

const API_ROUTES = {
  '/api/meta': metaOf,
  '/api/overview': (api, url) => api.overview(url.searchParams),
  '/api/trend': (api, url) => api.trend(url.searchParams),
  '/api/profit': (api, url) => api.profit(url.searchParams),
  '/api/channels': (api, url) => api.channels(url.searchParams),
  '/api/groups': (api, url) => api.groups(url.searchParams),
  '/api/users': (api, url) => api.users(url.searchParams),
  '/api/models': (api, url) => api.models(url.searchParams),
  '/api/capital': (api, url) => api.capital(url.searchParams),
  '/api/upstreams': (api, url) => api.upstreams(url.searchParams),
  '/api/quality': (api) => api.quality(),
  '/api/errors': (api, url) => api.errors(url.searchParams),
  '/api/status': (api, url) => api.status(url.searchParams),
  '/api/routes': (api) => api.routeGraph(),
  '/api/rows': (api, url) => api.rows(url.searchParams),
  '/api/healthz': () => ({ ok: true }),
};

/**
 * GET /api/* 的进程内缓存。
 *
 * 动机：冷缓存下 /api/channels 要 8 s 左右（单线程同步 sqlite，期间整个服务不可用），
 * 前端每 15 分钟整点后才刷新一次，数据延迟 60 s 对看板没有可见影响。
 *
 * - key = 完整 path + query string，value 是已经序列化好的响应体，命中时省掉查库和 JSON.stringify。
 * - 只由调用方缓存成功的 200；抛错的请求（400/500）到不了 set，4xx（未知接口）走 404 分支也不进缓存。
 * - 条目上限 maxEntries，超了按插入顺序删最早的（Map 天然按插入顺序迭代，够用，不做精确 LRU）。
 * - TTL 固定窗口、命中不续期：数据最多落后 ttlMs，不会因为持续访问一直不更新。
 * - API_CACHE_TTL_MS=0 关闭缓存（调试用）。
 */
export function createApiCache({ ttlMs = cacheTtlFromEnv(), maxEntries = 200, now = Date.now } = {}) {
  const entries = new Map();
  const enabled = Number.isFinite(ttlMs) && ttlMs > 0;
  return {
    enabled,
    ttlMs,
    maxEntries,
    get(key) {
      if (!enabled) return null;
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.at >= ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit.payload;
    },
    set(key, payload) {
      if (!enabled) return;
      entries.set(key, { payload, at: now() });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/** API_CACHE_TTL_MS：缺省 60 s，0 关闭；非法值退回默认，避免一个笔误把缓存变成永久 */
function cacheTtlFromEnv(raw = process.env.API_CACHE_TTL_MS) {
  if (raw == null || raw === '') return 60_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

/**
 * 跑一个 /api/* 请求并处理缓存。未知接口返回 null，由调用方回 404。
 * 返回的 payload 是 JSON 字符串，cache 是 'HIT' / 'MISS'（不缓存的接口为 null）。
 */
export function respondApi({ api, cache, pathname, url }) {
  const handler = API_ROUTES[pathname];
  if (!handler) return null;
  const cacheable = pathname !== '/api/healthz';
  // 归属随路由快照变化：key 带快照身份，旧 HIT 在快照更新后自动失效；TTL 与容量不变
  const version = cacheable && typeof api?.cacheVersion === 'function' ? api.cacheVersion() : 'none';
  const key = `${pathname}${url.search}|v=${version}`;
  if (cacheable) {
    const hit = cache.get(key);
    if (hit !== null) return { payload: hit, cache: 'HIT' };
  }
  const payload = JSON.stringify(handler(api, url));
  if (cacheable) cache.set(key, payload);
  return { payload, cache: cacheable && cache.enabled ? 'MISS' : null };
}

/** 图标参数的 id 形态：渠道只接受数字，账户只接受安全 id 字符 */
const LOGO_ID_PATTERN = {
  channel: /^\d{1,12}$/,
  account: /^[A-Za-z0-9._-]{1,128}$/,
  site: /^current$/,
};

/** 设置请求体上限：16 KiB，足够放下三组阈值加 revision */
export const SETTINGS_BODY_LIMIT = 16 * 1024;

/** 心跳缺失时的空状态；心跳损坏也回退到它，并额外带 error 字段 */
function emptyCollectorStatus() {
  return {
    state: 'unconfirmed',
    observedRevision: null,
    updatedAt: null,
    effective: { logsMinutes: null, spendMinutes: null },
    overrides: { logs: false, spend: false },
    logsEnabled: null,
  };
}

/**
 * 心跳文件损坏不应让整个设置接口失败（尤其 PATCH 已写盘后再 500 会变成假失败），
 * 但也不能装作正常：回 unconfirmed 空状态 + collector.error 让前端可见。
 * 设置文件本身损坏仍在 settingsPayload 之前抛错，由上层回 500。
 */
function collectorStatusOf(settingsStore) {
  try {
    return settingsStore.readCollectorStatus();
  } catch (err) {
    console.error('[v2] 读取采集器状态失败', err?.message ?? err);
    return {
      ...emptyCollectorStatus(),
      error: '采集器状态文件不可读，已按未确认展示',
    };
  }
}

/** GET/PATCH 共用的响应体：settings 三组 + defaults 五组 + revision + 采集器状态 */
function settingsPayload(settingsStore) {
  const snapshot = settingsStore.read();
  return {
    settings: snapshot.settings,
    defaults: {
      display: SHARED_DEFAULTS.display,
      refresh: SHARED_DEFAULTS.refresh,
      ...snapshot.defaults,
    },
    revision: snapshot.revision,
    collector: collectorStatusOf(settingsStore),
  };
}

function isLoopbackAddress(address) {
  const text = String(address ?? '');
  return text === '127.0.0.1' || text === '::1' || text === '::ffff:127.0.0.1';
}

/**
 * 判断请求实际使用的协议。只有本机反代（loopback）传来的 X-Forwarded-Proto 可信，
 * 其它来源一律看连接本身，避免外部伪造 https 骗过同源校验。
 */
function requestScheme(req) {
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0].trim().toLowerCase();
    if (forwarded === 'http' || forwarded === 'https') return forwarded;
  }
  return req.socket?.encrypted ? 'https' : 'http';
}

/** 写接口必须同源：Origin 的协议与 host 必须和当前请求一致，缺 Origin 直接拒绝 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers.host;
  if (!host) return false;
  return parsed.protocol === `${requestScheme(req)}:` && parsed.host === host;
}

/** 读请求体，超过上限只标记不中断连接，交给调用方回 413 */
function readLimitedBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooLarge, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

/** GET/HEAD 只读；PATCH 校验后写盘并清缓存，不触发任务、不重启服务 */
async function handleSettingsRequest({ req, res, head, settingsStore, cache }) {
  if (req.method === 'GET' || head) {
    sendJson(res, 200, settingsPayload(settingsStore), { head });
    return;
  }
  if (req.method !== 'PATCH') {
    req.resume();
    sendError(res, 405, 'method_not_allowed', '设置接口只支持 GET/HEAD/PATCH');
    return;
  }
  if (!originAllowed(req)) {
    req.resume();
    sendError(res, 403, 'forbidden_origin', '请求来源与站点不同源');
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    req.resume();
    sendError(res, 415, 'unsupported_media_type', '请求体必须是 application/json');
    return;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > SETTINGS_BODY_LIMIT) {
    req.resume();
    sendError(res, 413, 'payload_too_large', '请求体超过 16 KiB 上限');
    return;
  }
  const { tooLarge, text } = await readLimitedBody(req, SETTINGS_BODY_LIMIT);
  if (tooLarge) {
    sendError(res, 413, 'payload_too_large', '请求体超过 16 KiB 上限');
    return;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    sendError(res, 400, 'bad_json', '请求体不是合法 JSON');
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'invalid_settings', '请求体必须是 {settings, revision} 对象');
    return;
  }
  const unknown = Object.keys(body).filter((key) => key !== 'settings' && key !== 'revision');
  if (unknown.length > 0) {
    sendError(res, 400, 'invalid_settings', `请求体包含未知字段 ${unknown.join(', ')}`);
    return;
  }
  if (typeof body.revision !== 'string') {
    sendError(res, 400, 'invalid_settings', 'revision 必须是字符串');
    return;
  }
  if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
    sendError(res, 400, 'invalid_settings', 'settings 必须是对象');
    return;
  }
  try {
    settingsStore.update(body.settings, body.revision);
  } catch (err) {
    if (err instanceof RevisionConflictError) {
      sendError(res, 409, 'revision_conflict', err.message);
      return;
    }
    if (err instanceof RuntimeSettingsError) {
      sendError(res, 400, 'invalid_settings', err.message);
      return;
    }
    throw err;
  }
  // 阈值可能影响 /api/status 的分类，立即失效缓存，保证下一次 GET 用新规则
  cache.clear();
  sendJson(res, 200, settingsPayload(settingsStore));
}

/**
 * 请求处理入口：抽成工厂后，测试可以注入临时库、临时 dataDir 与真实 listen(0)，
 * 生产路径（缓存、401/405、静态文件）保持不变。
 */
export function createRequestHandler({
  api,
  cache,
  settingsStore,
  dashboard = null,
  now = Date.now,
  logoService = null,
  webDir = WEB_DIR,
}) {
  return async (req, res) => {
    const head = req.method === 'HEAD';
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/api/settings') {
        await handleSettingsRequest({ req, res, head, settingsStore, cache });
        return;
      }

      if (pathname === '/api/services') {
        if (req.method !== 'GET' && !head) {
          sendError(res, 405, 'method_not_allowed', '服务状态只支持 GET/HEAD', { head });
          return;
        }
        for (const key of url.searchParams.keys()) {
          if (key !== 'range' && key !== 'from' && key !== 'to') {
            sendError(res, 400, 'bad_request', `不支持的参数 ${key}`, { head });
            return;
          }
        }
        const fromRaw = url.searchParams.get('from');
        const toRaw = url.searchParams.get('to');
        let range = '24h';
        let from = null;
        let to = null;
        if (fromRaw != null || toRaw != null) {
          if (url.searchParams.has('range')) {
            sendError(res, 400, 'bad_request', 'range 与 from/to 不能同时使用', { head });
            return;
          }
          if (fromRaw == null || toRaw == null || fromRaw.trim() === '' || toRaw.trim() === '') {
            sendError(res, 400, 'bad_request', 'from/to 必须成对提供', { head });
            return;
          }
          from = Number(fromRaw);
          to = Number(toRaw);
          if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to) {
            sendError(res, 400, 'bad_request', 'from 必须是小于 to 的毫秒时间戳', { head });
            return;
          }
          if (to - from > 31 * 24 * 60 * 60 * 1000) {
            sendError(res, 400, 'bad_request', '自定义区间不能超过 31 天', { head });
            return;
          }
        } else {
          range = url.searchParams.get('range') ?? '24h';
          if (range !== '24h' && range !== '7d') {
            sendError(res, 400, 'bad_request', 'range 只能是 24h 或 7d', { head });
            return;
          }
        }
        if (!dashboard) {
          sendError(res, 500, 'internal_error', '服务状态不可用', { head });
          return;
        }
        // 设置文件损坏仍按 500 暴露；心跳损坏由 collectorStatusOf 降级为 unconfirmed+error
        const snapshot = settingsStore.read();
        const collector = collectorStatusOf(settingsStore);
        const payload = buildServiceHealth({
          dashboard,
          settings: snapshot.settings,
          collector,
          now: now(),
          range,
          from,
          to,
        });
        sendPayload(res, 200, JSON.stringify(payload), { head });
        return;
      }

      if (pathname === '/api/site-logo') {
        if (req.method !== 'GET' && !head) {
          sendError(res, 405, 'method_not_allowed', '站点图标只支持 GET/HEAD', { head });
          return;
        }
        for (const key of url.searchParams.keys()) {
          if (key !== 'kind' && key !== 'id' && key !== 'v') {
            sendError(res, 400, 'bad_request', `不支持的参数 ${key}`, { head });
            return;
          }
        }
        // v 仅作为缓存破坏版本：缺省兼容旧 URL，出现时只接受 2
        if (url.searchParams.getAll('v').some((value) => value !== '2')) {
          sendError(res, 400, 'bad_request', 'v 只接受 2', { head });
          return;
        }
        const kind = url.searchParams.get('kind');
        const id = url.searchParams.get('id');
        const pattern = Object.hasOwn(LOGO_ID_PATTERN, kind) ? LOGO_ID_PATTERN[kind] : null;
        if (!pattern || !id || !pattern.test(id)) {
          sendError(res, 400, 'bad_request', 'kind 只接受 channel/account/site，id 形态非法', { head });
          return;
        }
        if (!logoService) {
          sendError(res, 503, 'logo_unavailable', '站点图标服务未启用', { head });
          return;
        }
        let logo = null;
        try {
          logo = await logoService.getLogo({ kind, id });
        } catch {
          logo = null;
        }
        if (!logo) {
          sendLogoMiss(res, { head });
          return;
        }
        sendLogo(res, logo, { head });
        return;
      }

      if (req.method !== 'GET' && !head) {
        sendError(res, 405, 'method_not_allowed', '只支持 GET/HEAD', { head });
        return;
      }

      if (pathname.startsWith('/api/')) {
        const result = respondApi({ api, cache, pathname, url });
        if (!result) {
          sendError(res, 404, 'not_found', `未知接口 ${pathname}`, { head });
          return;
        }
        sendPayload(res, 200, result.payload, {
          head,
          headers: result.cache ? { 'X-Cache': result.cache } : {},
        });
        return;
      }

      serveStatic(res, pathname, { head, webDir });
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) {
        sendError(res, 400, 'bad_request', err.message, { head });
      } else {
        console.error('[v2] 请求失败', req.url, err);
        if (!res.headersSent) sendError(res, 500, 'internal_error', '服务内部错误', { head });
        else res.end();
      }
    }
  };
}

/**
 * 首屏预热：默认 7 天区间的 overview/trend/profit/channels/capital 各跑一次，
 * 把首屏要读的页读进 page cache（索引由写入侧的 openLogsDb 补齐，服务端只读）。
 * 后台执行、不阻塞监听；单项失败只告警、不影响其余接口；WARMUP=0 关闭。
 */
function warmup(api) {
  if (process.env.WARMUP === '0') {
    console.log('[warmup] skipped');
    return;
  }
  setImmediate(() => {
    const startedAt = Date.now();
    const jobs = [
      ['overview', (params) => api.overview(params)],
      ['trend', (params) => api.trend(params)],
      ['profit', (params) => api.profit(params)],
      ['channels', (params) => api.channels(params)],
      ['capital', (params) => api.capital(params)],
    ];
    let failed = 0;
    for (const [name, run] of jobs) {
      try {
        const params = new URLSearchParams();
        if (name === 'trend' || name === 'profit') params.set('granularity', 'day');
        run(params);
      } catch (err) {
        failed += 1;
        console.warn(`[warmup] ${name} 预热失败: ${err.message}`);
      }
    }
    console.log(`[warmup] ${failed === 0 ? 'ok' : `完成，失败 ${failed} 项`} ${Date.now() - startedAt}ms`);
  });
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[v2] ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      '用法: node v2/server.mjs [--port=8788] [--host=127.0.0.1] [--site=<站点 id>] [--source=<db 路径>] [--config=<instance.json>]',
    );
    return;
  }

  // 源库优先用实例的站点库；首次部署还没跑过采集时，退回 NewAPI 的源库
  let sourcePath;
  if (opts.source) {
    sourcePath = path.resolve(opts.source);
  } else if (fs.existsSync(INSTANCE.paths.siteDbFile)) {
    sourcePath = INSTANCE.paths.siteDbFile;
  } else if (fs.existsSync(INSTANCE.paths.relayDb)) {
    sourcePath = INSTANCE.paths.relayDb;
  } else {
    sourcePath = INSTANCE.paths.siteDbFile;
  }
  const sourceLabel = displayPath(sourcePath);

  const source = openSourceDb(sourcePath);
  const { file: configFile, writable: configWritable } = resolveConfigFile(V2_DIR);
  // 全新部署还没有账户配置：照常起服务，只是上游成本为空
  const config = fs.existsSync(configFile)
    ? loadConfig(configFile, { writable: configWritable })
    : {
      file: null,
      writable: false,
      currency: 'USD',
      quota_per_unit: 500000,
      upstream: {},
      accounts: [],
    };
  if (!config.file) {
    console.warn(`[v2] 未找到账户配置，上游成本与账户列表暂为空：${displayPath(configFile)}`);
  }
  ensureDataDirs(INSTANCE);
  const dashboard = openDashboardDb(DASHBOARD_FILE);
  syncAccounts(dashboard, config.accounts.filter((a) => a.enabled));
  // 采集间隔的「恢复默认」取实例部署值（毫秒 ÷ 60000，允许小数），不强行改成 15 分钟
  const settingsStore = createRuntimeSettingsStore({
    dataDir: INSTANCE.paths.dataDir,
    collectionDefaults: {
      logsMinutes: INSTANCE.collect.logsIntervalMs / 60_000,
      spendMinutes: INSTANCE.collect.spendIntervalMs / 60_000,
    },
  });
  const api = createApi({
    source,
    dashboard,
    config,
    siteName: opts.site,
    sourceLabel,
    getHealthSettings: () => settingsStore.read().settings.health,
    siteBaseUrl: INSTANCE.site.base_url,
  });
  const cache = createApiCache();

  // 图标服务只认配置/快照白名单解析出的 origin，不接收任意 URL 参数
  const logoService = createSiteLogoService({
    dataDir: INSTANCE.paths.dataDir,
    resolveSource: (input) => api.siteLogoSource(input),
  });

  const server = http.createServer(createRequestHandler({ api, cache, settingsStore, dashboard, logoService }));

  server.on('error', (err) => {
    console.error(`[v2] 服务启动失败: ${err.message}`);
    process.exit(1);
  });

  server.listen(opts.port, opts.host, () => {
    console.log(
      `[v2] http://${opts.host}:${opts.port}  源库=${sourceLabel}  看板库=${displayPath(DASHBOARD_FILE)}` +
        `  配置=${configFile ? displayPath(configFile) : '默认'}  实例=${INSTANCE_FILE ? displayPath(INSTANCE_FILE) : '默认'}` +
        `  运行时设置=${displayPath(settingsStore.path)}`,
    );
    warmup(api);
  });

  const shutdown = () => {
    server.close(() => {
      try {
        source.close();
        dashboard.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 只有直接执行时才启动：被测试 import 时不该占用端口。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node
/**
 * v2 本地预览服务：只读站点库，静态服务 v2/web，API 见 v2/CONTRACT.md。
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
import { openDashboardDb, syncAccounts } from './store/dashboard.mjs';
import { ensureAggIndexes, LOGS_SCHEMA } from './store/site-logs.mjs';

const V2_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(V2_DIR, '..');
const WEB_DIR = path.join(V2_DIR, 'web');
const VENDOR_DIR = path.join(ROOT, 'web', 'vendor');
const DASHBOARD_FILE = INSTANCE.paths.dashboardFile;

/** 页面自身的 html/js/css 不做强缓存：本地改完刷新就能生效 */
const NO_CACHE_EXT = new Set(['.html', '.js', '.mjs', '.css']);

/** 第三方库不带版本号，只能靠一年期强缓存；改库时必须换文件名，否则浏览器不会重新拉取 */
const IMMUTABLE_PREFIX = '/vendor/';
const IMMUTABLE_FILES = new Set(['/vendor-tabler.css']);
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function isImmutableAsset(pathname) {
  return pathname.startsWith(IMMUTABLE_PREFIX) || IMMUTABLE_FILES.has(pathname);
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
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
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

function sendJson(res, status, body, { head = false } = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
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
  if (decoded.includes('\0')) return null;
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
    'Cache-Control': immutable
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

function serveStatic(req, res, pathname, { head }) {
  const routes = [
    { prefix: '/vendor/', root: VENDOR_DIR },
    { prefix: '/', root: WEB_DIR },
  ];
  const route = routes.find((r) => pathname.startsWith(r.prefix));
  if (!route) return sendText(res, 404, 'Not Found', { head });

  let rel = pathname.slice(route.prefix.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = safeJoin(route.root, rel);
  if (!file) return sendError(res, 400, 'bad_path', '非法路径', { head });

  try {
    if (serveFile(res, file, { head, immutable: isImmutableAsset(pathname) })) return undefined;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
  }
  if (pathname === '/') {
    return sendText(res, 404, 'v2/web/index.html 不存在，前端静态文件尚未就位', { head });
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
  '/api/upstreams': (api, url) => api.upstreams(url.searchParams),
  '/api/quality': (api) => api.quality(),
  '/api/rows': (api, url) => api.rows(url.searchParams),
  '/api/healthz': () => ({ ok: true }),
};

/**
 * 首屏预热：默认 7 天区间的 overview/trend/profit 各跑一次，把首屏要读的页读进 page cache。
 * 后台执行、不阻塞监听；失败只告警不影响服务；WARMUP=0 关闭。
 */
function warmup(api) {
  if (process.env.WARMUP === '0') {
    console.log('[warmup] skipped');
    return;
  }
  setImmediate(() => {
    const startedAt = Date.now();
    try {
      const params = new URLSearchParams();
      api.overview(params);
      params.set('granularity', 'day');
      api.trend(params);
      api.profit(params);
      console.log(`[warmup] ok ${Date.now() - startedAt}ms`);
    } catch (err) {
      console.warn(`[warmup] 预热失败: ${err.message}`);
    }
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
  const api = createApi({
    source,
    dashboard,
    config,
    siteName: opts.site,
    sourceLabel,
  });

  const server = http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    try {
      if (req.method !== 'GET' && !head) {
        sendError(res, 405, 'method_not_allowed', '只支持 GET/HEAD', { head });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        const handler = API_ROUTES[pathname];
        if (!handler) {
          sendError(res, 404, 'not_found', `未知接口 ${pathname}`, { head });
          return;
        }
        sendJson(res, 200, handler(api, url), { head });
        return;
      }

      serveStatic(req, res, pathname, { head });
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) {
        sendError(res, 400, 'bad_request', err.message, { head });
      } else {
        console.error('[v2] 请求失败', req.url, err);
        if (!res.headersSent) sendError(res, 500, 'internal_error', '服务内部错误', { head });
        else res.end();
      }
    }
  });

  server.on('error', (err) => {
    console.error(`[v2] 服务启动失败: ${err.message}`);
    process.exit(1);
  });

  server.listen(opts.port, opts.host, () => {
    console.log(
      `[v2] http://${opts.host}:${opts.port}  源库=${sourceLabel}  看板库=${displayPath(DASHBOARD_FILE)}` +
        `  配置=${configFile ? displayPath(configFile) : '默认'}  实例=${INSTANCE_FILE ? displayPath(INSTANCE_FILE) : '默认'}`,
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

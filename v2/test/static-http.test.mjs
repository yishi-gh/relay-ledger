/** 构建产物的真实 HTTP 测试：临时静态目录、夹具库、loopback 随机端口。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { createRuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { createApiCache, createRequestHandler } from '../server.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const INDEX = '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-CdEf5678.css"></head>'
  + '<body><div id="root"></div><script type="module" src="/assets/index-AbCd1234.js"></script></body></html>';
const ASSETS = {
  '/assets/index-AbCd1234.js': ['text/javascript; charset=utf-8', 'console.log("fixture");'],
  '/assets/index-CdEf5678.css': ['text/css; charset=utf-8', 'body { color: black; }'],
  '/assets/font-D3f4g5h6.woff2': ['font/woff2', Buffer.from([0, 1, 2, 255])],
  '/assets/font-E4g5h6i7.woff': ['font/woff', Buffer.from([0, 2, 3, 254])],
  '/assets/logo-F5h6i7j8.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
};

async function startServer(t, { missingBuild = false } = {}) {
  const dir = makeTempDir('v2-static-http-');
  const webDir = path.join(dir, 'dist');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const settingsStore = createRuntimeSettingsStore({ dataDir: path.join(dir, 'data') });
  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'static-test',
    sourceLabel: 'fixture.db',
  });
  const server = http.createServer(createRequestHandler({
    api,
    cache: createApiCache(),
    settingsStore,
    webDir,
  }));
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, body) => {
    const file = path.join(webDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  if (!missingBuild) {
    write('index.html', INDEX);
    for (const [name, [, body]] of Object.entries(ASSETS)) write(name.slice(1), body);
    write('assets/plain.js', 'console.log("plain");');
    write('assets/style.css', 'body {}');
    write('assets/short-abc123.js', 'console.log("short hash");');
    write('assets/page-AbCd1234.html', '<html>页面</html>');
    write('outside-AbCd1234.js', 'console.log("outside assets");');
    // 同名静态文件不得覆盖 API 路由。
    write('api/healthz', 'static healthz');
    write('api/meta', 'static meta');
    write('api/settings', 'static settings');
    write('api/unknown', 'static unknown');
  }
  fs.writeFileSync(path.join(dir, 'outside.txt'), '不得泄露的目录外内容');

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    settingsStore,
    webDir,
  };
}

function request(fx, pathname, { method = 'GET', headers = {}, body } = {}) {
  // 直接传原始 path，避免客户端先把目录穿越路径规范化。
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: fx.port,
      path: pathname,
      method,
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('根路径与 query 视图发布构建入口，HTML 始终 no-cache', async (t) => {
  const fx = await startServer(t);
  for (const pathname of ['/', '/?view=ops', '/index.html', '/assets/page-AbCd1234.html']) {
    const res = await request(fx, pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    if (!pathname.startsWith('/assets/')) assert.equal(res.text, INDEX);
  }
});

test('入口引用的 hash assets 可读取，脚本、样式、字体、SVG 的 MIME 与不可变缓存正确', async (t) => {
  const fx = await startServer(t);
  const index = await request(fx, '/');
  const references = [...index.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(references.length, 2);
  for (const name of references) assert.ok(Object.hasOwn(ASSETS, name), name);
  for (const [name, [mime, body]] of Object.entries(ASSETS)) {
    const res = await request(fx, `${name}?v=1`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers['content-type'], mime, name);
    assert.equal(res.headers['cache-control'], IMMUTABLE_CACHE, name);
    assert.equal(Number(res.headers['content-length']), Buffer.byteLength(body), name);
    assert.deepEqual(res.buffer, Buffer.from(body), name);
  }
});

test('无 hash、短 hash、assets 外的文件不使用不可变缓存', async (t) => {
  const fx = await startServer(t);
  for (const name of ['/assets/plain.js', '/assets/style.css', '/assets/short-abc123.js', '/outside-AbCd1234.js']) {
    const res = await request(fx, name);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers['cache-control'], 'no-cache', name);
  }
});

test('HEAD 保持 GET 状态、MIME、长度及缓存头，响应体为空', async (t) => {
  const fx = await startServer(t);
  for (const name of ['/', ...Object.keys(ASSETS), '/missing.js', '/api/healthz']) {
    const get = await request(fx, name);
    const head = await request(fx, name, { method: 'HEAD' });
    assert.equal(head.status, get.status, name);
    for (const header of ['content-type', 'content-length', 'cache-control']) {
      assert.equal(head.headers[header], get.headers[header], `${name}: ${header}`);
    }
    assert.equal(head.buffer.length, 0, name);
  }
});

test('构建目录或入口缺失返回 503 与明确构建命令，API 仍可用', async (t) => {
  const fx = await startServer(t, { missingBuild: true });
  for (const directoryExists of [false, true]) {
    if (directoryExists) fs.mkdirSync(fx.webDir, { recursive: true });
    for (const name of ['/', '/?view=ops', '/index.html']) {
      const get = await request(fx, name);
      assert.equal(get.status, 503);
      assert.match(get.text, /frontend\/dist\/index\.html/);
      assert.ok(get.text.includes('npm --prefix frontend ci'));
      assert.ok(get.text.includes('npm --prefix frontend run build'));
      assert.equal(get.headers['cache-control'], 'no-store');
      const head = await request(fx, name, { method: 'HEAD' });
      assert.equal(head.status, 503);
      assert.equal(head.headers['content-length'], get.headers['content-length']);
      assert.equal(head.text, '');
    }
    assert.equal((await request(fx, '/missing.js')).status, 404);
    assert.deepEqual(JSON.parse((await request(fx, '/api/healthz')).text), { ok: true });
  }
});

test('路径穿越、非法编码与 NUL 被拒绝，不泄露根目录外文件', async (t) => {
  const fx = await startServer(t);
  for (const name of [
    '/%2e%2e%2foutside.txt',
    '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
    '/%2e%2e%5coutside.txt',
    '/assets%5c..%5c..%5coutside.txt',
    '/%00',
    '/%ZZ',
  ]) {
    const res = await request(fx, name);
    assert.equal(res.status, 400, name);
    assert.equal(JSON.parse(res.text).error.code, 'bad_path', name);
    assert.ok(!res.text.includes('不得泄露'), name);
  }
  assert.equal((await request(fx, '/../outside.txt')).status, 404);
});

test('未知资源与旧 vendor 地址返回 404，路径视图不回退到 SPA 入口', async (t) => {
  const fx = await startServer(t);
  for (const name of ['/missing.js', '/assets/absent-AbCd1234.js', '/index.html/child', '/ops',
    '/ops/', '/vendor/echarts.min.js', '/vendor-tabler.css']) {
    const res = await request(fx, name);
    assert.equal(res.status, 404, name);
    assert.equal(res.text, 'Not Found\n', name);
  }
  const post = await request(fx, '/', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('API 优先于静态文件，设置 PATCH 仍要求同源', async (t) => {
  const fx = await startServer(t);
  const health = await request(fx, '/api/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(health.text), { ok: true });
  const meta = await request(fx, '/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(JSON.parse(meta.text).source, 'fixture.db');
  const unknown = await request(fx, '/api/unknown');
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(unknown.text).error.code, 'not_found');

  const initial = await request(fx, '/api/settings');
  const snapshot = JSON.parse(initial.text);
  const body = JSON.stringify({ settings: snapshot.settings, revision: snapshot.revision });
  for (const origin of [null, 'https://other.example']) {
    const res = await request(fx, '/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body,
    });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, 'forbidden_origin');
    assert.equal(fs.existsSync(fx.settingsStore.path), false);
  }
  const updated = await request(fx, '/api/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json', origin: fx.base }, body,
  });
  assert.equal(updated.status, 200, updated.text);
  assert.ok(fs.existsSync(fx.settingsStore.path));
});

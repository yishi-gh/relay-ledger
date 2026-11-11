import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import { createSiteLogoService } from '../lib/site-logos.mjs';

// 所有网络与 DNS 都注入；包括私网用例在内均不创建真实连接。
const ORIGIN = 'https://site.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const DAY = 24 * 60 * 60 * 1000;
const INPUT = { kind: 'channel', id: 'one' };
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#369" d="M0 0h32v32H0z"/></svg>');

function ico() {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 1;
  header[7] = 1;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(PNG.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, PNG]);
}

function html(body = '') {
  return { contentType: 'text/html; charset=utf-8', body };
}

function image(body = PNG, contentType = 'image/png') {
  return { contentType, body };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function transport(route) {
  const calls = [];
  const pinned = [];
  let active = 0;
  let peak = 0;
  const request = (options, callback) => {
    const req = new EventEmitter();
    let incoming;
    let destroyed = false;
    let released = false;
    let timer;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    req.destroy = () => {
      destroyed = true;
      clearTimeout(timer);
      incoming?.destroy();
      release();
    };
    req.end = () => {
      active += 1;
      peak = Math.max(peak, active);
      calls.push(options);
      options.lookup(options.hostname, { all: true }, (error, records) => {
        assert.ifError(error);
        pinned.push(records);
      });
      queueMicrotask(() => {
        if (destroyed) return;
        let reply;
        try {
          reply = route(options, calls.length) ?? { status: 404 };
        } catch (error) {
          req.emit('error', error);
          release();
          return;
        }
        if (reply.hang) return;
        const send = () => {
          if (destroyed) return;
          if (reply.error) {
            req.emit('error', reply.error);
            release();
            return;
          }
          incoming = new PassThrough();
          const destroy = incoming.destroy.bind(incoming);
          incoming.destroy = (...args) => { release(); return destroy(...args); };
          incoming.complete = false;
          incoming.statusCode = reply.status ?? 200;
          incoming.headers = {
            ...(reply.contentType ? { 'content-type': reply.contentType } : {}),
            ...(reply.location ? { location: reply.location } : {}),
            ...reply.headers,
          };
          incoming.on('close', release);
          incoming.on('end', release);
          callback(incoming);
          for (const chunk of reply.chunks ?? [reply.body ?? '']) {
            if (incoming.destroyed) break;
            incoming.write(chunk);
          }
          if (!incoming.destroyed) {
            incoming.complete = true;
            incoming.end();
          }
        };
        if (reply.waitFor) {
          void reply.waitFor.then(() => {
            try { send(); } catch (error) { req.emit('error', error); release(); }
          });
        } else if (reply.delayMs) timer = setTimeout(send, reply.delayMs);
        else send();
      });
    };
    return req;
  };
  return { request, calls, pinned, get peak() { return peak; }, get active() { return active; } };
}

async function fixture(t, options = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'relay-site-logos-'));
  const route = options.route ?? (({ path }) => path === '/' ? html() : image());
  const network = transport((requestOptions, index) => requestOptions.path === '/api/status'
    ? options.status?.(requestOptions, index) ?? { status: 404 } : route(requestOptions, index));
  const dnsCalls = [];
  const lookup = options.lookup ?? ((hostname, lookupOptions, callback) => {
    dnsCalls.push({ hostname, options: lookupOptions });
    queueMicrotask(() => callback(null, [{ address: '8.8.8.8', family: 4 }]));
  });
  const parameters = {
    dataDir,
    resolveSource: options.resolveSource ?? (() => ORIGIN),
    now: options.now ?? (() => 1000),
    timeoutMs: options.timeoutMs ?? 8000,
    lookup,
    request: network.request,
  };
  const service = createSiteLogoService(parameters);
  t.after(async () => {
    await service.drain();
    if (!options.dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  const metadata = async (origin = ORIGIN) => JSON.parse(await readFile(join(dataDir, 'site-logos',
    `${createHash('sha256').update(origin).digest('hex')}.json`), 'utf8'));
  return { ...service, dataDir, network, dnsCalls, metadata, parameters };
}

test('HTML 相对 icon：同源重定向后按页面路径解析，坏 CDN 候选回退并解码属性', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => {
      if (path === '/') return { status: 302, location: '/pages/index.html' };
      if (path === '/pages/index.html') return html(`
        <link rel="icon" href="https://cdn.example/logo.png">
        <link href='../assets/logo.png?v=1&amp;size=16' REL='shortcut ICON'>`);
      if (path === '/assets/logo.png?v=1&size=16') return image();
      return { status: 404 };
    },
  });
  assert.deepEqual(await service.getLogo(INPUT), { body: PNG, contentType: 'image/png' });
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/', '/pages/index.html', '/logo.png', '/assets/logo.png?v=1&size=16']);
  assert.equal(service.dnsCalls.length, 5);
  assert.ok(service.dnsCalls.every(({ options }) => options.all === true));
});

test('apple-touch-icon 与无引号属性可用，注释内声明不会被使用', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => path === '/'
      ? html('<!-- <link rel=icon href=/ignored> --><link rel=apple-touch-icon href=/apple.png>')
      : path === '/apple.png' ? image() : { status: 404 },
  });
  assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/', '/apple.png']);
});

test('空首页回退 favicon.ico，ICO MIME 规范化后缓存', async (t) => {
  const body = ico();
  const service = await fixture(t, {
    route: ({ path }) => path === '/' ? html() : image(body, 'image/vnd.microsoft.icon'),
  });
  assert.deepEqual(await service.getLogo(INPUT), { body, contentType: 'image/x-icon' });
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/', '/favicon.ico']);
  assert.equal((await service.metadata()).contentType, 'image/x-icon');
});

test('GIF、WebP 与 JPEG 魔数可识别', async (t) => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 6, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  for (const [body, type] of [[GIF, 'image/gif'], [WEBP, 'image/webp'], [jpeg, 'image/jpeg']]) {
    await t.test(type, async (subtest) => {
      const service = await fixture(subtest, { route: ({ path }) => path === '/' ? html() : image(body, type) });
      assert.deepEqual(await service.getLogo(INPUT), { body, contentType: type });
    });
  }
});

test('7 天正缓存：相同 origin 跨渠道、账号与服务实例复用，命中不续期', async (t) => {
  let clock = 1000;
  const service = await fixture(t, { now: () => clock });
  const first = await service.getLogo(INPUT);
  const metadata = await service.metadata();
  assert.equal(metadata.source, ORIGIN);
  assert.equal(metadata.expires, 1000 + 7 * DAY);
  clock += 7 * DAY - 1;
  assert.deepEqual(await service.getLogo({ kind: 'account', id: 'another' }), first);
  const restarted = createSiteLogoService({ ...service.parameters,
    request: () => assert.fail('有效磁盘缓存不应访问网络') });
  assert.deepEqual(await restarted.getLogo(INPUT), first);
  assert.equal((await service.metadata()).expires, metadata.expires);
  assert.equal(service.network.calls.length, 3);
});

test('6 小时负缓存与到期重试，不缓存上游错误正文', async (t) => {
  let clock = 1000;
  const service = await fixture(t, {
    now: () => clock,
    route: () => ({ status: 403, body: 'upstream-sensitive-error-body' }),
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 3);
  assert.deepEqual(await service.metadata(), {
    version: 2, source: ORIGIN, expires: 1000 + DAY / 4, contentType: null, fileName: null,
  });
  clock += DAY / 4 - 1;
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 3);
  clock += 1;
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 6);
  const files = await readdir(join(service.dataDir, 'site-logos'));
  assert.equal(files.length, 1);
  assert.ok(!(await readFile(join(service.dataDir, 'site-logos', files[0]), 'utf8')).includes('sensitive'));
});

test('相同 origin 首次并发合并，只抓取一份首页与图标', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => ({ ...(path === '/' ? html() : image()), delayMs: 10 }),
  });
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => service.getLogo({
    kind: index % 2 ? 'channel' : 'account', id: String(index),
  })));
  assert.ok(results.every((result) => result?.body.equals(PNG)));
  assert.equal(service.network.calls.length, 3);
});

test('过期图标立即返回并异步更新；刷新失败保留旧图标并等待 6 小时再试', async (t) => {
  let clock = 1000;
  let failing = false;
  const refreshStarted = deferred();
  const refreshGate = deferred();
  const service = await fixture(t, {
    now: () => clock,
    route: ({ path }) => {
      if (!failing) return path === '/' ? html() : image();
      refreshStarted.resolve();
      return { status: 503, waitFor: refreshGate.promise };
    },
  });
  const first = await service.getLogo(INPUT);
  clock += 7 * DAY;
  failing = true;
  try {
    assert.deepEqual(await service.getLogo(INPUT), first);
    await refreshStarted.promise;
    assert.equal(service.network.active, 1);
    assert.equal((await service.metadata()).expires, clock);
  } finally {
    refreshGate.resolve();
  }
  await service.drain();
  assert.equal((await service.metadata()).expires, clock + DAY / 4);
  const calls = service.network.calls.length;
  assert.deepEqual(await service.getLogo(INPUT), first);
  assert.equal(service.network.calls.length, calls);
  assert.equal(service.network.active, 0);
});

test('过期正缓存可后台刷新成功并重新获得 7 天 TTL', async (t) => {
  let clock = 1000;
  let changed = false;
  const service = await fixture(t, {
    now: () => clock,
    route: ({ path }) => path === '/' ? html() : changed ? image(GIF, 'image/gif') : image(),
  });
  await service.getLogo(INPUT);
  clock += 7 * DAY;
  changed = true;
  assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  await service.drain();
  assert.deepEqual(await service.getLogo(INPUT), { body: GIF, contentType: 'image/gif' });
  assert.equal((await service.metadata()).expires, clock + 7 * DAY);
});

test('16 个不同 origin 首次请求进入队列，最多并发 4 个且全部取得图标', async (t) => {
  const service = await fixture(t, {
    resolveSource: ({ id }) => `https://site${id}.example`,
    route: ({ path }) => ({ ...(path === '/' ? html() : image()), delayMs: 5 }),
    timeoutMs: 8000,
  });
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    service.getLogo({ kind: 'channel', id: String(index) })));
  assert.ok(results.every((result) => result?.body.equals(PNG)));
  await service.drain();
  assert.equal(service.network.active, 0);
  assert.equal(service.network.calls.length, 48);
  assert.equal(service.network.peak, 4);
});

test('队列上限 64，排队与抓取共用预算，未尝试任务不写负缓存且能立即重试', async (t) => {
  let hanging = true;
  const service = await fixture(t, {
    resolveSource: ({ id }) => `https://site${id}.example`,
    route: ({ path }) => hanging ? { hang: true } : path === '/' ? html() : image(),
    timeoutMs: 8000,
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = 0;
  const jobs = Array.from({ length: 70 }, (_, index) =>
    service.getLogo({ kind: 'channel', id: String(index) }).then((result) => {
      completed += 1;
      return result;
    }));
  try {
    // 4 个执行 + 64 个等待，剩余 2 个因队列已满结束；不用真实超时碰运气。
    const deadline = performance.now() + 5000;
    while ((completed < 2 || service.network.calls.filter(({ path }) => path === '/').length < 4)
      && performance.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(completed, 2);
    assert.equal(service.network.calls.length, 8);
    t.mock.timers.tick(8000);
    const results = await Promise.all(jobs);
    assert.ok(results.every((result) => result === null));
    await service.drain();
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(service.network.active, 0);
  assert.equal(service.network.calls.length, 8);
  const attempted = new Set(service.network.calls.map(({ hostname }) => `https://${hostname}`));
  const files = await readdir(join(service.dataDir, 'site-logos'));
  assert.equal(files.length, 4);
  for (const file of files) {
    const metadata = JSON.parse(await readFile(join(service.dataDir, 'site-logos', file), 'utf8'));
    assert.ok(attempted.has(metadata.source));
    assert.equal(metadata.contentType, null);
  }
  hanging = false;
  const unattempted = Array.from({ length: 70 }, (_, index) => String(index))
    .find((id) => !attempted.has(`https://site${id}.example`));
  assert.deepEqual((await service.getLogo({ kind: 'channel', id: unattempted })).body, PNG);
});

test('getLogo 超时返回后 drain 等待后台缓存写入，清理目录后无延迟重建', async (t) => {
  const started = deferred();
  const service = await fixture(t, { route: () => { started.resolve(); return { hang: true }; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const jobs = [service.getLogo(INPUT), service.getLogo(INPUT)];
    await started.promise;
    t.mock.timers.tick(8000);
    assert.ok((await Promise.all(jobs)).every((result) => result === null));
    await service.drain();
  } finally {
    t.mock.timers.reset();
  }
  assert.equal((await service.metadata()).contentType, null);
  assert.equal(service.network.active, 0);
  await rm(join(service.dataDir, 'site-logos'), { recursive: true, force: true });
  await service.drain();
  assert.deepEqual(await readdir(service.dataDir), []);
});

test('非法图片、SVG、MIME 不匹配与非 200 状态均返回 null', async (t) => {
  const cases = [
    image(Buffer.from('<html>not an image</html>')),
    image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'), 'image/svg+xml'),
    image(PNG.subarray(0, 8)),
    image(PNG, 'image/jpeg'),
    image(PNG, 'application/octet-stream'),
    { ...image(), status: 500 },
    { ...image(), headers: { 'content-encoding': 'gzip' } },
    image(Buffer.from([0, 0, 1, 0, 1, 0])),
  ];
  for (const [index, reply] of cases.entries()) {
    await t.test(String(index), async (subtest) => {
      const service = await fixture(subtest, { route: ({ path }) => path === '/' ? html() : reply });
      assert.equal(await service.getLogo(INPUT), null);
      assert.equal((await service.metadata()).contentType, null);
    });
  }
});

test('图片 Content-Length 与响应流分别限制为 1 MiB', async (t) => {
  for (const reply of [
    { ...image(), headers: { 'content-length': String(1024 * 1024 + 1) } },
    { contentType: 'image/png', chunks: [PNG, Buffer.alloc(1024 * 1024)] },
  ]) {
    await t.test(reply.headers ? '声明超长' : '流式超长', async (subtest) => {
      const service = await fixture(subtest, { route: ({ path }) => path === '/' ? html() : reply });
      assert.equal(await service.getLogo(INPUT), null);
      assert.equal(service.network.active, 0);
    });
  }
});

test('首页超过 512 KiB 时停止读取并回退 favicon.ico', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => path === '/'
      ? { contentType: 'text/html', chunks: [Buffer.alloc(512 * 1024), Buffer.from('overflow')] }
      : image(),
  });
  assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  assert.equal(service.network.calls.length, 3);
  assert.equal(service.network.active, 0);
});

test('超时覆盖完整流程并取消连接，持续无响应 DNS 同样不会卡住', async (t) => {
  await t.test('首页和图标共用预算', async (subtest) => {
    const pageStarted = deferred();
    const pageGate = deferred();
    const iconStarted = deferred();
    const service = await fixture(subtest, {
      route: ({ path }) => {
        if (path === '/') {
          pageStarted.resolve();
          return { ...html(), waitFor: pageGate.promise };
        }
        iconStarted.resolve();
        return { hang: true };
      },
    });
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const job = service.getLogo(INPUT);
      await pageStarted.promise;
      subtest.mock.timers.tick(4000);
      pageGate.resolve();
      await iconStarted.promise;
      subtest.mock.timers.tick(4000);
      assert.equal(await job, null);
      await service.drain();
      assert.equal(service.network.active, 0);
    } finally {
      pageGate.resolve();
      subtest.mock.timers.reset();
    }
  });
  await t.test('DNS 不回调', async (subtest) => {
    const started = deferred();
    const service = await fixture(subtest, { lookup: () => started.resolve() });
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const job = service.getLogo(INPUT);
      await started.promise;
      subtest.mock.timers.tick(8000);
      assert.equal(await job, null);
      await service.drain();
      assert.equal(service.network.calls.length, 0);
      assert.equal((await service.metadata()).contentType, null);
    } finally {
      subtest.mock.timers.reset();
    }
  });
  assert.throws(() => createSiteLogoService({ dataDir: 'unused', resolveSource: () => null, timeoutMs: 8001 }), RangeError);
});

test('跨源、协议变化与第四次重定向被拒绝，不请求目标站', async (t) => {
  for (const location of ['https://other.example/icon.png', 'http://site.example/icon.png', 'https://site.example:9443/icon.png']) {
    await t.test(location, async (subtest) => {
      const service = await fixture(subtest, { route: () => ({ status: 302, location }) });
      assert.equal(await service.getLogo(INPUT), null);
      assert.equal(service.network.calls.length, 2);
    });
  }
  await t.test('重定向上限', async (subtest) => {
    const service = await fixture(subtest, { route: (_options, index) => ({ status: 302, location: `/hop${index}` }) });
    assert.equal(await service.getLogo(INPUT), null);
    assert.equal(service.network.calls.length, 5);
  });
});

test('图标重定向指向私网时被拒绝', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => path === '/' ? html() : { status: 302, location: 'http://127.0.0.1/private' },
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 3);
});

test('拒绝私网、保留、元数据与 IPv4 映射 IPv6 地址，任一 DNS 记录不安全即拒绝', async (t) => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '127.0.0.1', '100.64.0.1', '100.100.100.200',
    '100.127.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '192.0.0.192', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '168.63.129.16',
    '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:192.168.1.1', '::ffff:a00:1', '64:ff9b::a00:1', '2001:db8::1',
    '2001::1', '2002:0a00:0001::1', '3fff::1',
  ];
  const service = await fixture(t, {
    resolveSource: ({ id }) => `https://blocked${id}.example`,
    lookup: (hostname, options, callback) => {
      assert.equal(options.all, true);
      const index = Number(hostname.match(/^blocked(\d+)/)[1]);
      callback(null, [{ address: '8.8.8.8', family: 4 }, { address: blocked[index], family: isIP(blocked[index]) }]);
    },
  });
  for (const [index, address] of blocked.entries()) {
    assert.equal(await service.getLogo({ kind: 'account', id: String(index) }), null, address);
  }
  assert.equal(service.network.calls.length, 0);
});

test('私网 IP 字面量在连接之前被拒绝', async (t) => {
  for (const origin of ['http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]']) {
    const service = await fixture(t, { resolveSource: () => origin });
    assert.equal(await service.getLogo(INPUT), null);
    assert.equal(service.network.calls.length, 0);
    assert.equal(service.dnsCalls.length, 0);
  }
});

test('DNS rebinding：连接 lookup 固定安全 IP，重定向重新校验并拒绝变私网', async (t) => {
  let lookups = 0;
  const service = await fixture(t, {
    lookup: (_hostname, options, callback) => {
      assert.equal(options.all, true);
      lookups += 1;
      callback(null, [{ address: lookups <= 2 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
    },
    route: () => ({ status: 302, location: '/redirected' }),
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(lookups, 3);
  assert.equal(service.network.calls.length, 2);
  assert.deepEqual(service.network.pinned, Array(2).fill([{ address: '8.8.8.8', family: 4 }]));
});

test('公网 IPv6、9443 与原域名 TLS SNI 保留，只发送 User-Agent 和 Accept', async (t) => {
  const service = await fixture(t, {
    resolveSource: () => 'https://api.site.example:9443/private?ignored=1',
    lookup: (_hostname, _options, callback) => callback(null, [{ address: '2606:4700:4700::1111', family: 6 }]),
  });
  assert.ok(await service.getLogo(INPUT));
  assert.ok(service.network.calls.every((options) => options.hostname === 'api.site.example'
    && options.servername === 'api.site.example' && options.port === '9443'
    && options.agent === false && options.autoSelectFamily === false));
  for (const options of service.network.calls) {
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
    assert.equal(options.auth, undefined);
    let selected;
    options.lookup(options.hostname, {}, (error, address, family) => {
      assert.ifError(error);
      selected = { address, family };
    });
    assert.deepEqual(selected, { address: '2606:4700:4700::1111', family: 6 });
  }
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/', '/favicon.ico']);
});

test('只接受可信 resolver 的结果，非法 kind/id/url 不发起请求', async (t) => {
  let resolutions = 0;
  const service = await fixture(t, {
    resolveSource: ({ id }) => {
      resolutions += 1;
      if (id === 'throw') throw new Error('resolver failed');
      return null;
    },
  });
  for (const input of [null, {}, { kind: 'other', id: 'one' }, { kind: 'channel', id: 1 },
    { kind: 'channel', id: '' }]) assert.equal(await service.getLogo(input), null);
  assert.equal(resolutions, 0);
  assert.equal(await service.getLogo({ kind: 'account', id: 'missing', url: 'http://127.0.0.1' }), null);
  assert.equal(await service.getLogo({ kind: 'account', id: 'throw' }), null);
  assert.equal(service.network.calls.length, 0);
  for (const origin of ['file:///etc/passwd', 'javascript:alert(1)', 'http://bad_host.example',
    'https://singlelabel', 'https://site.example:8080', 'https://visitor@site.example', 'invalid']) {
    const invalid = createSiteLogoService({ ...service.parameters, resolveSource: () => origin });
    assert.equal(await invalid.getLogo(INPUT), null);
  }
  assert.equal(service.network.calls.length, 0);
});

test('用户 id 与伪造缓存 metadata 文件名不能穿越缓存目录', async (t) => {
  const service = await fixture(t);
  assert.ok(await service.getLogo({ kind: 'account', id: '../../outside' }));
  const key = createHash('sha256').update(ORIGIN).digest('hex');
  const cacheDir = join(service.dataDir, 'site-logos');
  assert.deepEqual((await readdir(cacheDir)).sort(), [`${key}.image`, `${key}.json`].sort());
  assert.equal((await service.metadata()).fileName, `${key}.image`);
  await writeFile(join(service.dataDir, 'outside.png'), PNG);
  await writeFile(join(cacheDir, `${key}.json`), JSON.stringify({
    version: 2, source: ORIGIN, expires: 99999999, contentType: 'image/png', fileName: '../outside.png',
  }));
  const invalid = createSiteLogoService({ ...service.parameters,
    request: transport(() => ({ status: 404 })).request });
  assert.equal(await invalid.getLogo(INPUT), null);
  assert.deepEqual(await readFile(join(service.dataDir, 'outside.png')), PNG);
});

test('损坏、过大缓存与 source 不匹配均重新获取，失败时不返回伪图片', async (t) => {
  const service = await fixture(t, { route: () => ({ status: 404 }) });
  const key = createHash('sha256').update(ORIGIN).digest('hex');
  const cacheDir = join(service.dataDir, 'site-logos');
  await mkdir(cacheDir, { recursive: true });
  for (const metadata of ['{', 'x'.repeat(4097), JSON.stringify({
    version: 2, source: 'https://other.example', expires: 99999999, contentType: 'image/png', fileName: `${key}.image`,
  }), JSON.stringify({ version: 2, source: ORIGIN, expires: 99999999, contentType: 'image/png', fileName: `${key}.image` })]) {
    await writeFile(join(cacheDir, `${key}.json`), metadata);
    await writeFile(join(cacheDir, `${key}.image`), Buffer.alloc(1024 * 1024 + 1));
    assert.equal(await service.getLogo(INPUT), null);
  }
  assert.equal(service.network.calls.length, 12);
});

function panelStatus(logo, name = '自定义品牌') {
  return { contentType: 'application/json', body: JSON.stringify({ success: true,
    data: { logo, system_name: name } }) };
}

test('status 自定义相对 logo 先于 HTML 和 favicon，按来源 origin 解析', async (t) => {
  const service = await fixture(t, {
    status: () => panelStatus('assets/brand.png'),
    route: ({ path }) => path === '/assets/brand.png' ? image() : { status: 404 },
  });
  assert.deepEqual(await service.getLogo(INPUT), { body: PNG, contentType: 'image/png' });
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/assets/brand.png']);
  assert.ok(!(await service.metadata()).source.includes('/api/status'));
});

test('status 公网 CDN 图标允许跨源重定向，每跳解析 DNS 并固定 IP 与 SNI', async (t) => {
  const service = await fixture(t, {
    status: () => panelStatus('https://assets.brand.example/icon.svg'),
    route: ({ hostname }) => hostname === 'assets.brand.example'
      ? { status: 302, location: 'https://cdn.brand.example/brand.svg' }
      : hostname === 'cdn.brand.example' ? image(SVG, 'image/svg+xml') : { status: 404 },
  });
  assert.deepEqual(await service.getLogo(INPUT), { body: SVG, contentType: 'image/svg+xml' });
  assert.deepEqual(service.network.calls.map(({ hostname }) => hostname), [
    'site.example', 'assets.brand.example', 'cdn.brand.example',
  ]);
  assert.equal(service.dnsCalls.length, 3);
  assert.ok(service.network.calls.every((options) => options.servername === options.hostname
    && Object.keys(options.headers).length === 2 && options.auth === undefined));
  assert.deepEqual(service.network.pinned, Array(3).fill([{ address: '8.8.8.8', family: 4 }]));
});

test('status 支持 PNG base64、SVG percent 编码与 GIF 二进制 percent data URI', async (t) => {
  const variants = [
    [`data:image/png;base64,${PNG.toString('base64')}`, PNG, 'image/png'],
    [`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG.toString())}`, SVG, 'image/svg+xml'],
    [`data:image/gif,${[...GIF].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}`, GIF, 'image/gif'],
  ];
  for (const [uri, body, contentType] of variants) {
    await t.test(contentType, async (subtest) => {
      const service = await fixture(subtest, { status: () => panelStatus(uri) });
      assert.deepEqual(await service.getLogo(INPUT), { body, contentType });
      assert.equal(service.network.calls.length, 1);
      assert.equal((await service.metadata()).source, ORIGIN);
      assert.deepEqual(await createSiteLogoService(service.parameters).getLogo(INPUT), { body, contentType });
    });
  }
});

test('非法或过大 data URI 不作为图片，不能绕过 MIME 和 SVG 安全校验', async (t) => {
  for (const uri of [
    'data:image/png;base64,not-base64',
    'data:image/png,%GG',
    `data:image/jpeg;base64,${PNG.toString('base64')}`,
    'data:text/html,%3Csvg%3E',
    `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>')}`,
    `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024 + 256)}`,
  ]) {
    const service = await fixture(t, { status: () => panelStatus(uri), route: ({ path }) =>
      path === '/' ? html() : { status: 404 } });
    assert.equal(await service.getLogo(INPUT), null);
  }
});

test('NewAPI/OneAPI 只有默认 logo 或 favicon 时返回 null，不冒用通用面板品牌', async (t) => {
  for (const logo of ['', '/logo.png', '/logo.svg?v=1', '/favicon.ico']) {
    const service = await fixture(t, {
      status: () => panelStatus(logo, 'New API'),
      route: ({ path }) => path === '/'
        ? html('<link rel=icon href=/favicon.ico><link rel=apple-touch-icon href=/logo.png>') : image(),
    });
    assert.equal(await service.getLogo(INPUT), null);
    assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/']);
  }
  const custom = await fixture(t, { status: () => panelStatus('', 'One API'),
    route: ({ path }) => path === '/' ? html('<link rel=icon href=/brand.svg>') : image(SVG, 'image/svg+xml') });
  assert.equal((await custom.getLogo(INPUT)).contentType, 'image/svg+xml');
});

test('status 必须 success=true 且包含 system_name，非法或登录响应继续 HTML 回退', async (t) => {
  for (const status of [
    { contentType: 'application/json', body: '{' },
    { contentType: 'application/json', body: '{"success":false,"data":{"system_name":"x","logo":"/wrong.png"}}' },
    { contentType: 'application/json', body: '{"success":true,"data":{"logo":"/wrong.png"}}' },
    { status: 401, body: 'private account error' },
  ]) {
    const service = await fixture(t, { status: () => status });
    assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
    assert.deepEqual(service.network.calls.map(({ path }) => path), ['/api/status', '/', '/favicon.ico']);
  }
});

test('HTML 图标优先安全 SVG，再 apple-touch/precomposed 和较大的栅格图标', async (t) => {
  const markup = '<link rel=icon sizes=16x16 href=/tiny.png>'
    + '<link rel=icon sizes=192x192 href=/large.png>'
    + '<link rel=apple-touch-icon-precomposed sizes=180x180 href=/touch.png>'
    + '<link rel=icon type=image/svg+xml href=https://cdn.brand.example/vector.svg>';
  for (const safe of [true, false]) {
    const service = await fixture(t, {
      route: ({ path }) => path === '/' ? html(markup) : path === '/vector.svg'
        ? image(safe ? SVG : Buffer.from('<svg><script/></svg>'), 'image/svg+xml') : image(GIF, 'image/gif'),
    });
    assert.equal((await service.getLogo(INPUT)).contentType, safe ? 'image/svg+xml' : 'image/gif');
    assert.deepEqual(service.network.calls.map(({ path }) => path), safe
      ? ['/api/status', '/', '/vector.svg'] : ['/api/status', '/', '/vector.svg', '/touch.png']);
  }
  const large = await fixture(t, { route: ({ path }) => path === '/'
    ? html('<link rel=icon sizes=16x16 href=/tiny.png><link rel=icon sizes="32x32 256x256" href=/large.png>') : image() });
  assert.ok(await large.getLogo(INPUT));
  assert.equal(large.network.calls.at(-1).path, '/large.png');
});

test('受限 SVG 接受静态渐变、裁剪、内部引用和白名单 style', async (t) => {
  const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <!-- 静态品牌图标 -->
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32">
      <defs><linearGradient id="paint"><stop offset="0" stop-color="#369"/></linearGradient>
        <clipPath id="clip"><rect width="32" height="32"/></clipPath><path id="shape" d="M0 0h32v32H0z"/></defs>
      <use xlink:href="#shape" clip-path="url(#clip)" style="fill:url(#paint);opacity:0.8"/>
    </svg>`);
  const service = await fixture(t, { status: () => panelStatus('/brand.svg'), route: () => image(body, 'image/svg+xml') });
  assert.deepEqual(await service.getLogo(INPUT), { body, contentType: 'image/svg+xml' });
});

test('SVG 拒绝脚本、事件、foreignObject、外部资源、DTD/entity、样式表与 XML 绕过', async (t) => {
  const wrap = (content, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${content}</svg>`;
  const bad = [
    wrap('<script>alert(1)</script><path d="M0 0"/>'),
    wrap('<path d="M0 0"/>', 'onload="alert(1)"'),
    wrap('<path onmouseover="alert(1)" d="M0 0"/>'),
    wrap('<foreignObject><div>html</div></foreignObject>'),
    wrap('<image href="https://evil.example/image.png"/>'),
    wrap('<use href="https://evil.example/icon.svg#shape"/>'),
    wrap('<use href="&#x6a;avascript:alert(1)"/>'),
    wrap('<path d="M0 0" fill="url(https://evil.example/paint.svg)"/>'),
    wrap('<path d="M0 0" style="fill:url(\\68 ttps://evil.example/p)"/>'),
    wrap('<path d="M0 0" style="background-image:url(#local)"/>'),
    wrap('<style>@import "https://evil.example/a.css";</style><path d="M0 0"/>'),
    wrap('<animate attributeName="href" values="javascript:alert(1)"/><path d="M0 0"/>'),
    wrap('<set attributeName="onload" to="alert(1)"/><path d="M0 0"/>'),
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + wrap('<text>&xxe;</text>'),
    '<?xml-stylesheet href="https://evil.example/a.css"?>' + SVG,
    wrap('<path d="M0 0"/>', 'xml:base="https://evil.example/"'),
    wrap('<use xlink:href="#x"/>', 'xmlns:xlink="http://evil.example/ns"'),
    wrap('<path d="M0 0"/>', 'fill="red" fill="blue"'),
    wrap('<path d="M0 0">'),
    wrap('<text>&unknown;</text>'),
    wrap('<path d="M0 0"/>') + '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    wrap('<path d="M0 0"/>', 'data-extra="x"'),
    Buffer.from('\ufeff' + SVG.toString(), 'utf16le'),
  ];
  for (const [index, value] of bad.entries()) {
    await t.test(String(index), async (subtest) => {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const service = await fixture(subtest, { status: () => panelStatus('/brand.svg'),
        route: ({ path }) => path === '/' ? html() : image(body, 'image/svg+xml') });
      assert.equal(await service.getLogo(INPUT), null);
      assert.equal((await service.metadata()).contentType, null);
    });
  }
});

test('gzip/br/deflate 首页和图标均可读取，gzip status JSON 同样可发现品牌 logo', async (t) => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]]) {
    const service = await fixture(t, { route: ({ path }) => ({
      contentType: path === '/' ? 'text/html' : 'image/png',
      body: compress(path === '/' ? Buffer.from('<link rel=icon href=/brand.png>') : PNG),
      headers: { 'content-encoding': encoding },
    }) });
    assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  }
  const compressed = panelStatus('/brand.png');
  const service = await fixture(t, { status: () => ({ ...compressed, body: gzipSync(compressed.body),
    headers: { 'content-encoding': 'gzip' } }), route: () => image() });
  assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  assert.equal(service.network.calls.length, 2);
});

test('压缩与解压流分别受限，解压炸弹、截断压缩流与未知编码被拒绝', async (t) => {
  for (const [encoding, body] of [
    ['gzip', gzipSync(Buffer.alloc(1024 * 1024 + 1))],
    ['br', brotliCompressSync(Buffer.alloc(1024 * 1024 + 1))],
    ['gzip', Buffer.alloc(1024 * 1024 + 1)],
    ['gzip', gzipSync(PNG).subarray(0, 10)],
    ['compress', PNG],
  ]) {
    const service = await fixture(t, { status: () => panelStatus('/brand.png'),
      route: ({ path }) => path === '/' ? html() : { contentType: 'image/png', body,
        headers: { 'content-encoding': encoding } } });
    assert.equal(await service.getLogo(INPUT), null);
    await service.drain();
    assert.equal(service.network.active, 0);
  }
  const htmlBomb = await fixture(t, { route: ({ path }) => path === '/'
    ? { contentType: 'text/html', body: gzipSync(Buffer.alloc(512 * 1024 + 1)), headers: { 'content-encoding': 'gzip' } }
    : image() });
  assert.deepEqual((await htmlBomb.getLogo(INPUT)).body, PNG);
});

test('status 探测 1200ms 子预算到期后继续 HTML，不吞掉全部 8s 预算', async (t) => {
  const started = deferred();
  const service = await fixture(t, { status: () => { started.resolve(); return { hang: true }; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const job = service.getLogo(INPUT);
    await started.promise;
    t.mock.timers.tick(1200);
    assert.deepEqual((await job).body, PNG);
    await service.drain();
    assert.equal(service.network.active, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test('API 子域无页面时仅回退一层父域，cache source 仍保留原来源', async (t) => {
  for (const prefix of ['api', 'www']) {
    const origin = `https://${prefix}.brand.com`;
    const service = await fixture(t, { resolveSource: () => origin,
      route: ({ hostname, path }) => hostname !== 'brand.com' ? { status: 404 }
        : path === '/' ? html('<link rel=icon href=/brand.png>') : image() });
    assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
    assert.equal((await service.metadata(origin)).source, origin);
    assert.deepEqual([...new Set(service.network.calls.map(({ hostname }) => hostname))], [`${prefix}.brand.com`, 'brand.com']);
  }
});

test('父域回退不剥公共后缀、不猜其它子域、不覆盖已有页面或面板的归属', async (t) => {
  for (const hostname of ['api.co.uk', 'www.co.uk', 'api.brand.co.uk', 'api.github.io',
    'api.appspot.com', 'api.api.brand.com', 'edge.brand.com', 'brand.com']) {
    const service = await fixture(t, { resolveSource: () => `https://${hostname}`, route: () => ({ status: 404 }) });
    assert.equal(await service.getLogo(INPUT), null);
    assert.ok(service.network.calls.every((options) => options.hostname === hostname));
  }
  for (const panel of [false, true]) {
    const service = await fixture(t, { resolveSource: () => 'https://api.brand.com',
      status: () => panel ? panelStatus('', 'New API') : { status: 404 },
      route: ({ path }) => path === '/' ? html(panel ? '' : '<title>existing page</title>') : { status: 404 } });
    assert.equal(await service.getLogo(INPUT), null);
    assert.ok(service.network.calls.every(({ hostname }) => hostname === 'api.brand.com'));
  }
});

test('site/current kind 可用，其余 site id 在调用 resolver 前拒绝', async (t) => {
  const inputs = [];
  const service = await fixture(t, { resolveSource: (input) => { inputs.push(input); return ORIGIN; } });
  assert.equal(await service.getLogo({ kind: 'site', id: 'elsewhere' }), null);
  assert.deepEqual(inputs, []);
  assert.deepEqual((await service.getLogo({ kind: 'site', id: 'current' })).body, PNG);
  assert.deepEqual(inputs, [{ kind: 'site', id: 'current' }]);
});

test('旧策略 6h negative 缓存立即重新发现，不删除其它缓存或真实数据', async (t) => {
  for (const version of [undefined, 1]) {
    const service = await fixture(t, { status: () => panelStatus('/brand.png'), route: () => image() });
    const key = createHash('sha256').update(ORIGIN).digest('hex');
    const directory = join(service.dataDir, 'site-logos');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${key}.json`), JSON.stringify({ version, source: ORIGIN,
      expires: 1000 + 6 * 60 * 60 * 1000, contentType: null, fileName: null }));
    await writeFile(join(directory, 'unrelated-cache.json'), 'keep');
    assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
    assert.equal((await service.metadata()).version, 2);
    assert.equal(await readFile(join(directory, 'unrelated-cache.json'), 'utf8'), 'keep');
  }
});

test('CDN DNS rebinding 与混合私网结果仍被拒绝，固定 lookup 不二次使用系统 DNS', async (t) => {
  const resolutions = [];
  const service = await fixture(t, {
    status: () => panelStatus('https://assets.brand.example/brand.png'),
    lookup: (hostname, options, callback) => {
      resolutions.push(hostname);
      assert.equal(options.all, true);
      callback(null, [{ address: hostname === 'private.brand.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }]);
    },
    route: ({ hostname, path }) => hostname === 'assets.brand.example'
      ? { status: 302, location: 'https://private.brand.example/logo.png' } : path === '/' ? html() : { status: 404 },
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.ok(resolutions.includes('private.brand.example'));
  assert.ok(service.network.calls.every(({ hostname }) => hostname !== 'private.brand.example'));
  assert.ok(service.network.pinned.every((records) => records[0].address === '8.8.8.8'));
  const mixed = await fixture(t, { status: () => panelStatus('https://cdn.brand.example/logo.png'),
    lookup: (hostname, _options, callback) => callback(null, hostname === 'cdn.brand.example'
      ? [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]
      : [{ address: '8.8.8.8', family: 4 }]), route: () => html() });
  assert.equal(await mixed.getLogo(INPUT), null);
  assert.ok(mixed.network.calls.every(({ hostname }) => hostname !== 'cdn.brand.example'));
});

test('发现的图标和重定向不能携带 userinfo、危险端口或非法 scheme', async (t) => {
  for (const value of ['https://visitor@cdn.brand.example/logo.png', 'https://cdn.brand.example:22/logo.png',
    'file:///etc/passwd', 'javascript:alert(1)', 'ftp://cdn.brand.example/logo.png']) {
    const service = await fixture(t, { status: () => panelStatus(value),
      route: ({ path }) => path === '/' ? html() : { status: 404 } });
    assert.equal(await service.getLogo(INPUT), null);
    assert.ok(service.network.calls.every(({ hostname }) => hostname === 'site.example'));
  }
  const redirect = await fixture(t, { status: () => panelStatus('https://cdn.brand.example/logo.png'),
    route: ({ path }) => path === '/' ? html() : { status: 302, location: 'https://visitor@other.brand.example/logo.png' } });
  assert.equal(await redirect.getLogo(INPUT), null);
  assert.ok(redirect.network.calls.every(({ hostname }) => hostname !== 'other.brand.example'));
});

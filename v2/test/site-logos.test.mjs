import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createSiteLogoService } from '../lib/site-logos.mjs';

// 所有网络与 DNS 都注入；包括私网用例在内均不创建真实连接。
const ORIGIN = 'https://site.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const DAY = 24 * 60 * 60 * 1000;
const INPUT = { kind: 'channel', id: 'one' };

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
  const network = transport(options.route ?? (({ path }) => path === '/' ? html() : image()));
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

test('HTML 相对 icon：同源重定向后按页面路径解析，忽略第三方图标并解码属性', async (t) => {
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
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/', '/pages/index.html', '/assets/logo.png?v=1&size=16']);
  assert.equal(service.dnsCalls.length, 3);
  assert.ok(service.dnsCalls.every(({ options }) => options.all === true));
});

test('apple-touch-icon 与无引号属性可用，注释内声明不会被使用', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => path === '/'
      ? html('<!-- <link rel=icon href=/ignored> --><link rel=apple-touch-icon href=/apple.png>')
      : path === '/apple.png' ? image() : { status: 404 },
  });
  assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/', '/apple.png']);
});

test('空首页回退 favicon.ico，ICO MIME 规范化后缓存', async (t) => {
  const body = ico();
  const service = await fixture(t, {
    route: ({ path }) => path === '/' ? html() : image(body, 'image/vnd.microsoft.icon'),
  });
  assert.deepEqual(await service.getLogo(INPUT), { body, contentType: 'image/x-icon' });
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/', '/favicon.ico']);
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
  assert.equal(service.network.calls.length, 2);
});

test('6 小时负缓存与到期重试，不缓存上游错误正文', async (t) => {
  let clock = 1000;
  const service = await fixture(t, {
    now: () => clock,
    route: () => ({ status: 403, body: 'upstream-sensitive-error-body' }),
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 2);
  assert.deepEqual(await service.metadata(), {
    source: ORIGIN, expires: 1000 + DAY / 4, contentType: null, fileName: null,
  });
  clock += DAY / 4 - 1;
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 2);
  clock += 1;
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 4);
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
  assert.equal(service.network.calls.length, 2);
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
  assert.equal(service.network.calls.length, 32);
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
    while (completed < 2 && performance.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(completed, 2);
    assert.equal(service.network.calls.length, 4);
    t.mock.timers.tick(8000);
    const results = await Promise.all(jobs);
    assert.ok(results.every((result) => result === null));
    await service.drain();
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(service.network.active, 0);
  assert.equal(service.network.calls.length, 4);
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

test('图片 Content-Length 与响应流分别限制为 512 KiB', async (t) => {
  for (const reply of [
    { ...image(), headers: { 'content-length': String(512 * 1024 + 1) } },
    { contentType: 'image/png', chunks: [PNG, Buffer.alloc(512 * 1024)] },
  ]) {
    await t.test(reply.headers ? '声明超长' : '流式超长', async (subtest) => {
      const service = await fixture(subtest, { route: ({ path }) => path === '/' ? html() : reply });
      assert.equal(await service.getLogo(INPUT), null);
      assert.equal(service.network.active, 0);
    });
  }
});

test('首页超过 256 KiB 时停止读取并回退 favicon.ico', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => path === '/'
      ? { contentType: 'text/html', chunks: [Buffer.alloc(256 * 1024), Buffer.from('overflow')] }
      : image(),
  });
  assert.deepEqual((await service.getLogo(INPUT)).body, PNG);
  assert.equal(service.network.calls.length, 2);
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
      assert.equal(service.network.calls.length, 1);
    });
  }
  await t.test('重定向上限', async (subtest) => {
    const service = await fixture(subtest, { route: (_options, index) => ({ status: 302, location: `/hop${index}` }) });
    assert.equal(await service.getLogo(INPUT), null);
    assert.equal(service.network.calls.length, 4);
  });
});

test('图标跨源重定向也被拒绝', async (t) => {
  const service = await fixture(t, {
    route: ({ path }) => path === '/' ? html() : { status: 302, location: 'http://127.0.0.1/private' },
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(service.network.calls.length, 2);
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
      callback(null, [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
    },
    route: () => ({ status: 302, location: '/redirected' }),
  });
  assert.equal(await service.getLogo(INPUT), null);
  assert.equal(lookups, 2);
  assert.equal(service.network.calls.length, 1);
  assert.deepEqual(service.network.pinned, [[{ address: '8.8.8.8', family: 4 }]]);
});

test('公网 IPv6、9443 与原域名 TLS SNI 保留，只发送 User-Agent 和 Accept', async (t) => {
  const service = await fixture(t, {
    resolveSource: () => 'https://visitor@api.site.example:9443/private?ignored=1',
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
  assert.deepEqual(service.network.calls.map(({ path }) => path), ['/', '/favicon.ico']);
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
    'https://singlelabel', 'https://site.example:8080', 'invalid']) {
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
    source: ORIGIN, expires: 99999999, contentType: 'image/png', fileName: '../outside.png',
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
    source: 'https://other.example', expires: 99999999, contentType: 'image/png', fileName: `${key}.image`,
  }), JSON.stringify({ source: ORIGIN, expires: 99999999, contentType: 'image/png', fileName: `${key}.image` })]) {
    await writeFile(join(cacheDir, `${key}.json`), metadata);
    await writeFile(join(cacheDir, `${key}.image`), Buffer.alloc(512 * 1024 + 1));
    assert.equal(await service.getLogo(INPUT), null);
  }
  assert.equal(service.network.calls.length, 8);
});

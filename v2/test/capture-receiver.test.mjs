/**
 * 采集接收器单测：健康检查、访问控制、请求校验、合并语义、原子写入。
 * 全部使用临时目录 + 端口 0，不读写真实 v2/secrets/accounts.json。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCaptureReceiver } from '../tools/capture-receiver.mjs';

const silentLogger = { info() {}, error() {} };
const CAPTURE_FILE = 'accounts.capture.json';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v2-receiver-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function entry(overrides = {}) {
  return {
    site_name: 'demo',
    site_url: 'https://demo.test',
    site_type: 'sub2api',
    account: { id: 'u1', name: 'alice', email: null },
    auth: {
      mode: 'bearer',
      token: 'token-a',
      cookie: '',
      refresh_token: 'refresh-a',
      expires_at: 1761003600000,
      user_id: null,
    },
    captured_at: 1761000000000,
    ...overrides,
  };
}

/** 每个测试一个临时目录 + 端口 0 的接收器，结束后关闭并清理 */
async function withReceiver(fn, options = {}) {
  const dir = tempDir();
  const file = path.join(dir, CAPTURE_FILE);
  const receiver = createCaptureReceiver({ file, port: 0, logger: silentLogger, ...options });
  const { port } = await receiver.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, file, dir, receiver });
  } finally {
    await receiver.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function post(base, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${base}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Ledger-Capture': '1',
      ...headers,
    },
    body: payload,
  });
}

test('/health 返回服务信息，不泄露文件路径与 token', async () => {
  await withReceiver(async ({ base, file }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, service: 'relay-ledger-capture-receiver', version: 1 });

    const text = JSON.stringify(body);
    assert.ok(!text.includes(file));
    assert.ok(!text.includes('accounts.capture.json'));
    assert.ok(!text.includes('token'));
  }, { token: 'secret-token-value' });
});

test('缺少 X-Relay-Ledger-Capture 头返回 403，且不创建文件', async () => {
  await withReceiver(async ({ base, file }) => {
    const res = await post(base, { accounts: [entry()] }, { 'X-Relay-Ledger-Capture': '' });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(file), false);
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});

test('配置 token 后：缺失 401、错误 401、正确 200', async () => {
  const token = 'local-dev-token';
  await withReceiver(async ({ base, file }) => {
    const missing = await post(base, { accounts: [entry()] });
    assert.equal(missing.status, 401);

    const wrong = await post(base, { accounts: [entry()] }, { 'X-Relay-Ledger-Token': 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(fs.existsSync(file), false);

    const ok = await post(base, { accounts: [entry()] }, { 'X-Relay-Ledger-Token': token });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).total, 1);
  }, { token });
});

test('坏 JSON 返回 400 且不改动文件', async () => {
  await withReceiver(async ({ base, file }) => {
    const res = await post(base, '{"accounts": [');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('Content-Type 不是 application/json 返回 415', async () => {
  await withReceiver(async ({ base }) => {
    const res = await post(base, JSON.stringify({ accounts: [entry()] }), {
      'Content-Type': 'text/plain',
    });
    assert.equal(res.status, 415);
  });
});

test('请求体超过 2 MiB 返回 413', async () => {
  await withReceiver(async ({ base, file }) => {
    const filler = 'x'.repeat(2 * 1024 * 1024 + 1024);
    const res = await post(base, { accounts: [entry({ note: filler })] });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).ok, false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('首次提交新增账户并写入可解析文件', async () => {
  await withReceiver(async ({ base, file, dir }) => {
    const res = await post(base, { schema_version: 1, accounts: [entry()] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      added: 1,
      updated: 0,
      total: 1,
      file: CAPTURE_FILE,
    });

    const json = readJson(file);
    assert.equal(json.schema_version, 1);
    assert.equal(json.accounts.length, 1);
    assert.equal(json.accounts[0].auth.token, 'token-a');
    assert.ok(json.captured_at > 0);

    const names = fs.readdirSync(dir);
    assert.deepEqual(names, [CAPTURE_FILE], '不应残留临时文件或 (1) 副本');
  });
});

test('同一账户重复提交以较新 captured_at 覆盖，不产生副本', async () => {
  await withReceiver(async ({ base, file, dir }) => {
    await post(base, { accounts: [entry()] });
    const res = await post(base, {
      accounts: [entry({
        captured_at: 1761000600000,
        auth: { mode: 'bearer', token: 'token-b', cookie: '', refresh_token: '', expires_at: 0, user_id: null },
      })],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      added: 0,
      updated: 1,
      total: 1,
      file: CAPTURE_FILE,
    });

    const json = readJson(file);
    assert.equal(json.accounts.length, 1);
    assert.equal(json.accounts[0].auth.token, 'token-b');
    assert.equal(json.accounts[0].captured_at, 1761000600000);
    assert.deepEqual(fs.readdirSync(dir), [CAPTURE_FILE]);
  });
});

test('较旧的 captured_at 不覆盖已有较新条目', async () => {
  await withReceiver(async ({ base, file }) => {
    await post(base, { accounts: [entry({ captured_at: 1761000600000 })] });
    const res = await post(base, {
      accounts: [entry({
        captured_at: 1761000000000,
        auth: { mode: 'bearer', token: 'old-token', cookie: '', refresh_token: '', expires_at: 0, user_id: null },
      })],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      added: 0,
      updated: 0,
      total: 1,
      file: CAPTURE_FILE,
    });
    const json = readJson(file);
    assert.equal(json.accounts[0].auth.token, 'token-a');
    assert.equal(json.accounts[0].captured_at, 1761000600000);
  });
});

test('保留既有其他账号与未知顶层字段', async () => {
  await withReceiver(async ({ base, file }) => {
    const existing = {
      schema_version: 1,
      captured_at: 1,
      note: 'keep-me',
      accounts: [entry({
        site_url: 'https://other.test',
        account: { id: 'u9', name: 'bob', email: null },
        captured_at: 1761000000000,
      })],
    };
    fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);

    const res = await post(base, { accounts: [entry()] });
    assert.equal(res.status, 200);
    const counts = await res.json();
    assert.equal(counts.added, 1);
    assert.equal(counts.total, 2);

    const json = readJson(file);
    assert.equal(json.note, 'keep-me');
    const sites = json.accounts.map((item) => item.site_url).sort();
    assert.deepEqual(sites, ['https://demo.test', 'https://other.test']);
  });
});

test('接受单个账户对象', async () => {
  await withReceiver(async ({ base, file }) => {
    const res = await post(base, entry());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).total, 1);
    assert.equal(readJson(file).accounts[0].account.id, 'u1');
  });
});

test('缺少 site_url 或顶层结构不对返回 400', async () => {
  await withReceiver(async ({ base, file }) => {
    const noSite = await post(base, { accounts: [{ account: { id: 'u1' } }] });
    assert.equal(noSite.status, 400);

    const arrayBody = await post(base, [entry()]);
    assert.equal(arrayBody.status, 400);

    assert.equal(fs.existsSync(file), false);
  });
});

test('OPTIONS 返回 405，且不带任何 CORS 头', async () => {
  await withReceiver(async ({ base }) => {
    const res = await fetch(`${base}/capture`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-relay-ledger-capture',
      },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-headers'), null);
  });
});

test('并发提交串行合并，全部账户都保留', async () => {
  await withReceiver(async ({ base, file, dir }) => {
    const jobs = Array.from({ length: 8 }, (_, i) => entry({
      account: { id: `u${i}`, name: `user${i}`, email: null },
      captured_at: 1761000000000 + i,
    }));
    const responses = await Promise.all(jobs.map((item) => post(base, { accounts: [item] })));
    assert.deepEqual(responses.map((res) => res.status), Array(8).fill(200));

    const json = readJson(file);
    assert.equal(json.accounts.length, 8);
    const ids = json.accounts.map((item) => item.account.id).sort();
    assert.deepEqual(ids, ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
    assert.deepEqual(fs.readdirSync(dir), [CAPTURE_FILE]);
  });
});

test('响应不包含 token、完整路径或账号内容', async () => {
  const token = 'receiver-shared-token';
  await withReceiver(async ({ base, file }) => {
    const res = await post(base, {
      accounts: [entry({
        account: { id: 'u1', name: 'alice', email: 'alice@example.test' },
        auth: { mode: 'bearer', token: 'upstream-secret', cookie: '', refresh_token: '', expires_at: 0, user_id: null },
      })],
    }, { 'X-Relay-Ledger-Token': token });
    assert.equal(res.status, 200);

    const text = await res.text();
    assert.ok(!text.includes(token));
    assert.ok(!text.includes('upstream-secret'));
    assert.ok(!text.includes(file));
    assert.ok(!text.includes('alice@example.test'));
    assert.ok(!text.includes(path.dirname(file)));
  }, { token });
});

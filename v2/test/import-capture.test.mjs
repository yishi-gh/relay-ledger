/**
 * 导入器单测：新增、同站多账号、更新并保留 channels、缺字段报错、
 * 不删除其他账户、重复 id 报错、报告不泄露凭据；
 * 可续期凭据（过期 token + cookie / refresh_token 仍导入）、
 * 过期且无法续期拒绝（expired_without_renewal）、旧 capture 不覆盖新（stale_capture）。
 * 全部使用临时目录 fixture，不读真实配置、不访问网络。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ImportError, importCapture } from '../tools/import-capture.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v2-import-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function captureFile(dir, accounts, extra = {}) {
  return writeJson(path.join(dir, 'accounts.capture.json'), {
    schema_version: 1,
    captured_at: 1761000000000,
    accounts,
    ...extra,
  });
}

function configFile(dir) {
  return path.join(dir, 'secrets', 'accounts.json');
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

test('新增 newapi / sub2api：默认配置、字段映射与 base_url 归一', () => {
  const dir = tempDir();
  try {
    const input = captureFile(dir, [
      entry({
        site_name: '123api',
        site_url: 'https://upstream-a.example.com/',
        site_type: 'sub2api',
        account: { id: '123', name: 'bob', email: null },
      }),
      entry({
        site_name: 'newapi',
        site_url: 'https://newapi.test',
        site_type: 'newapi',
        account: { id: '7', name: 'alice', email: 'a@example.test' },
        auth: {
          mode: 'bearer',
          token: 'newapi-token',
          cookie: '',
          refresh_token: '',
          expires_at: null,
          user_id: 7,
        },
      }),
    ]);

    const target = configFile(dir);
    const report = importCapture({ inputFile: input, configFile: target });
    assert.equal(report.added.length, 2);
    assert.equal(report.updated.length, 0);

    const saved = readJson(target);
    assert.equal(saved.version, 2);
    assert.equal(saved.currency, 'USD');
    assert.equal(saved.quota_per_unit, 500000);
    assert.ok(saved.upstream && typeof saved.upstream === 'object');
    assert.equal(saved.accounts.length, 2);

    const sub = saved.accounts.find((a) => a.kind === 'sub2api');
    assert.equal(sub.id, '123api:123');
    assert.equal(sub.base_url, 'https://upstream-a.example.com');
    assert.equal(sub.site_url, 'https://upstream-a.example.com');
    assert.deepEqual(sub.channels, []);
    assert.deepEqual(sub.endpoints, {
      balance: '/api/v1/auth/me',
      usage: '/api/v1/usage/stats?period=today',
    });
    assert.equal(sub.balance_field, 'balance');
    assert.equal(sub.quota_per_unit, null);
    assert.equal(sub.auth.mode, 'bearer');
    assert.equal(sub.auth.token, 'token-a');
    assert.equal(sub.auth.user_id, null);

    const newapi = saved.accounts.find((a) => a.kind === 'newapi');
    assert.equal(newapi.id, 'newapi:7');
    assert.deepEqual(newapi.endpoints, {
      balance: '/api/user/self',
      credits: '/api/log/self',
      usage: '/api/log/self/stat',
    });
    assert.equal(newapi.balance_field, 'quota');
    assert.equal(newapi.quota_per_unit, 500000);
    assert.equal(newapi.auth.user_id, 7);

    // site_name 缺失时用主机名
    assert.match(report.lines.join('\n'), /123api:123/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同站两个账号生成不同 id', () => {
  const dir = tempDir();
  try {
    const input = captureFile(dir, [
      entry({ account: { id: 'a', name: 'alice', email: null } }),
      entry({ account: { id: 'b', name: 'bob', email: null } }),
    ]);
    const target = configFile(dir);
    const report = importCapture({ inputFile: input, configFile: target });
    assert.equal(report.added.length, 2);
    assert.deepEqual(
      report.added.map((a) => a.id).sort(),
      ['demo:a', 'demo:b'],
    );
    assert.equal(readJson(target).accounts.length, 2);

    // 无 site_name 时用 host
    const input2 = captureFile(dir, [
      entry({ site_name: '', site_url: 'https://host-only.test', account: { id: 'u9', name: 'carol', email: null } }),
    ]);
    importCapture({ inputFile: input2, configFile: target });
    assert.ok(readJson(target).accounts.some((a) => a.id === 'host-only-test:u9'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('已存在账户：更新 token，保留 channels / endpoints / 其他账户', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    const untouched = {
      id: 'other',
      name: '其他站点',
      kind: 'newapi',
      channels: [27],
      auth: { mode: 'bearer', token: 'keep-token', token_env: 'OTHER_TOKEN' },
    };
    writeJson(target, {
      version: 3,
      currency: 'USD',
      accounts: [
        {
          id: '123api:123',
          name: '123api',
          site_url: 'https://upstream-a.example.com',
          base_url: 'https://upstream-a.example.com',
          kind: 'sub2api',
          unit: 'USD',
          enabled: true,
          channels: [13, 14],
          account: { id: '123', name: 'old-name', email: null },
          auth: {
            mode: 'bearer',
            token: 'old-token',
            refresh_token: 'old-refresh',
            expires_at: null,
            user_id: null,
            token_env: 'CAP_TOKEN',
          },
          endpoints: { balance: '/custom/balance', usage: '/custom/usage' },
          balance_field: 'balance',
          quota_per_unit: 500000,
        },
        untouched,
      ],
    });

    const input = captureFile(dir, [
      entry({
        site_name: '123api',
        site_url: 'https://upstream-a.example.com',
        site_type: 'sub2api',
        account: { id: '123', name: 'new-name', email: 'new@example.test' },
        auth: {
          mode: 'bearer',
          token: 'new-token',
          cookie: '',
          refresh_token: 'new-refresh',
          expires_at: 1761007200000,
          user_id: 123,
        },
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target });
    assert.equal(report.added.length, 0);
    assert.equal(report.updated.length, 1);
    assert.match(report.lines.join('\n'), /channels=2/);

    const saved = readJson(target);
    assert.equal(saved.version, 3);
    const merged = saved.accounts.find((a) => a.id === '123api:123');
    assert.equal(merged.auth.token, 'new-token');
    assert.equal(merged.auth.refresh_token, 'new-refresh');
    assert.equal(merged.auth.expires_at, 1761007200000);
    assert.equal(merged.auth.user_id, 123);
    assert.equal(merged.auth.token_env, 'CAP_TOKEN'); // 既有 auth 扩展字段保留
    assert.deepEqual(merged.channels, [13, 14]);
    assert.deepEqual(merged.endpoints, { balance: '/custom/balance', usage: '/custom/usage' });
    assert.equal(merged.name, '123api'); // 既有展示名不覆盖
    assert.equal(merged.account.email, 'new@example.test');

    assert.deepEqual(saved.accounts.find((a) => a.id === 'other'), untouched);
    assert.equal(saved.accounts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('既有站点级账户没有 account 元数据：按唯一 site_url 合并，保留 id 与 channels', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, {
      version: 2,
      accounts: [
        {
          id: 'legacy-site',
          name: '旧站点配置',
          base_url: 'https://legacy.test',
          kind: 'newapi',
          channels: [26],
          auth: { mode: 'bearer', token: 'old', token_env: 'LEGACY_TOKEN' },
        },
      ],
    });
    const input = captureFile(dir, [
      entry({
        site_name: 'legacy',
        site_url: 'https://legacy.test/',
        site_type: 'newapi',
        account: { id: '11780', name: 'upstream-a', email: 'a@example.test' },
        auth: { mode: 'bearer', token: 'new', refresh_token: '', expires_at: null, user_id: 11780 },
      }),
    ]);
    const report = importCapture({ inputFile: input, configFile: target });
    assert.equal(report.added.length, 0);
    assert.equal(report.updated.length, 1);
    const saved = readJson(target);
    assert.equal(saved.accounts.length, 1);
    assert.equal(saved.accounts[0].id, 'legacy-site');
    assert.deepEqual(saved.accounts[0].channels, [26]);
    assert.equal(saved.accounts[0].account.id, '11780');
    assert.equal(saved.accounts[0].auth.token, 'new');
    assert.equal(saved.accounts[0].auth.token_env, 'LEGACY_TOKEN');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缺字段 / 非法值明确报错', () => {
  const dir = tempDir();
  const target = configFile(dir);
  const cases = [
    ['schema_version 不是 1', [entry()], { schema_version: 2 }],
    ['accounts 不是数组', null, { accounts: {} }],
    ['site_url 缺失', [entry({ site_url: '' })]],
    ['site_url 非法', [entry({ site_url: 'not-a-url' })]],
    ['site_type 非法', [entry({ site_type: 'other' })]],
    ['account 缺失', [entry({ account: null })]],
    ['account 无标识', [entry({ account: { id: null, name: null, email: null } })]],
    ['auth 缺失', [entry({ auth: null })]],
    ['auth.mode 非法', [entry({ auth: { mode: 'password', token: 'x' } })]],
    ['bearer 无凭据', [entry({ auth: { mode: 'bearer', token: '', refresh_token: '' } })]],
    ['cookie 无 cookie', [entry({ auth: { mode: 'cookie', cookie: '' } })]],
  ];

  try {
    for (const [label, accounts, extra] of cases) {
      const file = path.join(dir, `case-${label.replace(/[^\w]+/g, '-')}.json`);
      if (accounts === null) {
        writeJson(file, { schema_version: 1, captured_at: 1, accounts: {} });
      } else {
        writeJson(file, { schema_version: 1, captured_at: 1, accounts, ...(extra ?? {}) });
      }
      assert.throws(
        () => importCapture({ inputFile: file, configFile: target }),
        (err) => {
          assert.ok(err instanceof ImportError, `${label}: 应为 ImportError`);
          assert.ok(err.message.length > 0);
          return true;
        },
        label,
      );
      assert.equal(fs.existsSync(target), false, `${label}: 失败时不应创建输出`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('采集文件里重复 id 报错', () => {
  const dir = tempDir();
  try {
    const input = captureFile(dir, [
      entry({ auth: { mode: 'bearer', token: 't1', refresh_token: '' } }),
      entry({ auth: { mode: 'bearer', token: 't2', refresh_token: '' } }),
    ]);
    assert.throws(
      () => importCapture({ inputFile: input, configFile: configFile(dir) }),
      (err) => err instanceof ImportError && /重复 id/.test(err.message),
    );
    assert.equal(fs.existsSync(configFile(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('既有配置里 id 重复时报错且不写文件', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, {
      version: 2,
      accounts: [
        { id: 'dup', kind: 'newapi', auth: { mode: 'bearer', token: 'x' } },
        { id: 'dup', kind: 'newapi', auth: { mode: 'bearer', token: 'y' } },
      ],
    });
    const before = fs.readFileSync(target, 'utf8');
    const input = captureFile(dir, [entry()]);
    assert.throws(
      () => importCapture({ inputFile: input, configFile: target }),
      (err) => err instanceof ImportError && /重复/.test(err.message),
    );
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('报告不含凭据，文件里保留凭据（不打印）', () => {
  const dir = tempDir();
  try {
    const token = 'SECRET-TOKEN-X';
    const refresh = 'SECRET-REFRESH-Y';
    const input = captureFile(dir, [
      entry({
        auth: {
          mode: 'bearer',
          token,
          cookie: '',
          refresh_token: refresh,
          expires_at: null,
          user_id: null,
        },
      }),
    ]);
    const target = configFile(dir);
    const report = importCapture({ inputFile: input, configFile: target });
    const text = report.lines.join('\n');

    assert.ok(!text.includes(token), '报告不应包含 token');
    assert.ok(!text.includes(refresh), '报告不应包含 refresh_token');
    assert.match(text, /demo:u1/);
    assert.match(text, /channels=0/);

    const saved = readJson(target);
    assert.equal(saved.accounts[0].auth.token, token);
    assert.equal(saved.accounts[0].auth.refresh_token, refresh);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write:false 只计算报告，不落盘', () => {
  const dir = tempDir();
  try {
    const input = captureFile(dir, [entry()]);
    const target = configFile(dir);
    const report = importCapture({ inputFile: input, configFile: target, write: false });
    assert.equal(report.added.length, 1);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('access token 已过期且无 refresh_token / cookie：拒绝导入，保留现有可用 token', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, {
      version: 2,
      accounts: [
        {
          id: 'demo:u1',
          name: 'demo',
          site_url: 'https://demo.test',
          base_url: 'https://demo.test',
          kind: 'newapi',
          channels: [7],
          account: { id: 'u1', name: 'alice', email: null },
          auth: { mode: 'bearer', token: 'usable-token', expires_at: 1761003600000 },
        },
      ],
    });
    const before = fs.readFileSync(target, 'utf8');

    const input = captureFile(dir, [
      entry({
        site_type: 'newapi',
        auth: {
          mode: 'bearer',
          token: 'expired-token',
          cookie: '',
          refresh_token: '',
          expires_at: 1761003600, // 秒级时间戳，且早于 now
          user_id: null,
        },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1762000000000 });
    assert.equal(report.added.length, 0);
    assert.equal(report.updated.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].reason, 'expired_without_renewal');
    assert.match(report.lines.join('\n'), /expired_without_renewal/);
    assert.ok(!report.lines.join('\n').includes('expired-token'), '报告不应包含 token');

    const saved = readJson(target);
    assert.equal(saved.accounts.length, 1);
    assert.equal(saved.accounts[0].auth.token, 'usable-token');
    assert.deepEqual(saved.accounts[0].channels, [7]);
    assert.notEqual(fs.readFileSync(target, 'utf8'), '');
    assert.ok(before.includes('usable-token'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('过期条目在目标里没有对应账户时也不新增', () => {
  const dir = tempDir();
  try {
    const input = captureFile(dir, [
      entry({
        auth: { mode: 'bearer', token: 'expired-token', cookie: '', refresh_token: '', expires_at: 1761003600000 },
      }),
    ]);
    const target = configFile(dir);
    const report = importCapture({ inputFile: input, configFile: target, now: 1762000000000 });
    assert.equal(report.added.length, 0);
    assert.equal(report.skipped[0].reason, 'expired_without_renewal');
    assert.equal(readJson(target).accounts.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('过期 token 有 Cookie 或 refresh_token 时可以导入（可续期）', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    const input = captureFile(dir, [
      entry({
        site_type: 'newapi',
        auth: {
          mode: 'bearer',
          token: 'expired-token',
          cookie: 'session=abc123; New-Api-User=1',
          refresh_token: '',
          expires_at: 1761003600000,
          user_id: 1,
        },
      }),
      entry({
        site_name: 'refresh',
        site_url: 'https://refresh.test',
        account: { id: 'u2', name: 'bob', email: null },
        auth: {
          mode: 'bearer',
          token: 'expired-token-2',
          cookie: '',
          refresh_token: 'refresh-2',
          expires_at: 1761003600000,
        },
      }),
      entry({
        site_name: 'cookieonly',
        site_url: 'https://cookieonly.test',
        site_type: 'newapi',
        account: { id: 'u3', name: 'carol', email: null },
        auth: { mode: 'cookie', cookie: 'session=xyz', user_id: 3 },
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1762000000000 });
    assert.equal(report.skipped.length, 0);
    assert.equal(report.added.length, 3);

    const saved = readJson(target);
    const withCookie = saved.accounts.find((a) => a.id === 'demo:u1');
    assert.equal(withCookie.auth.mode, 'bearer');
    assert.equal(withCookie.auth.token, 'expired-token');
    assert.equal(withCookie.auth.cookie, 'session=abc123; New-Api-User=1');
    assert.equal(withCookie.auth.user_id, 1);

    const withRefresh = saved.accounts.find((a) => a.id === 'refresh:u2');
    assert.equal(withRefresh.auth.refresh_token, 'refresh-2');
    assert.equal(withRefresh.auth.cookie, '');

    const cookieOnly = saved.accounts.find((a) => a.id === 'cookieonly:u3');
    assert.equal(cookieOnly.auth.mode, 'cookie');
    assert.equal(cookieOnly.auth.cookie, 'session=xyz');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('目标配置里 captured_at 更新时，旧 capture 不覆盖新凭据', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, {
      version: 2,
      accounts: [
        {
          id: 'demo:u1',
          name: 'demo',
          site_url: 'https://demo.test',
          base_url: 'https://demo.test',
          kind: 'sub2api',
          channels: [3],
          account: { id: 'u1', name: 'alice', email: null },
          auth: { mode: 'bearer', token: 'fresh-token', refresh_token: 'fresh-refresh' },
          captured_at: 1762000000000,
        },
      ],
    });

    const input = captureFile(dir, [
      entry({
        auth: {
          mode: 'bearer',
          token: 'old-token',
          cookie: '',
          refresh_token: '',
          expires_at: 1761500000000,
        },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761005000000 });
    assert.equal(report.updated.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].reason, 'stale_capture');
    assert.match(report.lines.join('\n'), /stale_capture/);

    const saved = readJson(target);
    assert.equal(saved.accounts[0].auth.token, 'fresh-token');
    assert.equal(saved.accounts[0].auth.refresh_token, 'fresh-refresh');
    assert.equal(saved.accounts[0].captured_at, 1762000000000);
    assert.deepEqual(saved.accounts[0].channels, [3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写入配置时归一化 captured_at 与秒级 expires_at', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    const input = captureFile(
      dir,
      [
        entry({
          auth: {
            mode: 'bearer',
            token: 't',
            cookie: '',
            refresh_token: 'r',
            expires_at: 1761003600, // 秒
          },
          // 条目没有 captured_at，用文件头的 captured_at
          captured_at: undefined,
        }),
      ],
      { captured_at: 1761000000 }, // 秒
    );

    importCapture({ inputFile: input, configFile: target, now: 1760000000000 });
    const saved = readJson(target);
    assert.equal(saved.accounts[0].auth.expires_at, 1761003600000);
    assert.equal(saved.accounts[0].captured_at, 1761000000000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一个结构合法（三段、payload 为 JSON 对象）的短命 JWT，仅用于测试 */
function shortJwt(payload = {}) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'u1', exp: 1761003600, ...payload })}.sig`;
}

function longLivedAccount(overrides = {}) {
  return {
    id: 'demo:u1',
    name: 'demo',
    site_url: 'https://demo.test',
    base_url: 'https://demo.test',
    kind: 'newapi',
    channels: [5],
    account: { id: 'u1', name: 'alice', email: null },
    auth: {
      mode: 'bearer',
      token: 'sk-long-lived-api-key',
      cookie: '',
      refresh_token: '',
      expires_at: null,
      user_id: 9,
    },
    captured_at: 1760000000000,
    ...overrides,
  };
}

test('现有长效 key + 新短命 JWT（无 cookie / refresh）：保留 token 与 expires_at', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, { version: 2, accounts: [longLivedAccount()] });
    const jwt = shortJwt();

    const input = captureFile(dir, [
      entry({
        site_type: 'newapi',
        auth: {
          mode: 'bearer',
          token: jwt,
          cookie: '',
          refresh_token: '',
          expires_at: 1761003600000,
          user_id: 9,
        },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761000000000 });
    assert.equal(report.added.length, 0);
    assert.equal(report.updated.length, 1);
    assert.equal(report.updated[0].reason, 'not_overwriting_long_lived_token');
    const text = report.lines.join('\n');
    assert.match(text, /^! demo:u1 .*跳过覆盖：not_overwriting_long_lived_token$/m);
    assert.ok(!text.includes('sk-long-lived-api-key'), '报告不应包含现有 token');
    assert.ok(!text.includes(jwt), '报告不应包含采集到的 JWT');

    const merged = readJson(target).accounts[0];
    assert.equal(merged.auth.token, 'sk-long-lived-api-key');
    assert.equal(merged.auth.expires_at, null);
    assert.deepEqual(merged.channels, [5]);
    // 确实合并了本次 capture，captured_at 前进，旧 capture 不会反过来覆盖
    assert.equal(merged.captured_at, 1761000000000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('现有长效 key + 新短命 JWT 带 cookie：token 不变、cookie 与 user_id 合并', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, {
      version: 2,
      accounts: [longLivedAccount({ auth: { ...longLivedAccount().auth, cookie: 'session=old-session' } })],
    });

    const input = captureFile(dir, [
      entry({
        site_type: 'newapi',
        auth: {
          mode: 'bearer',
          token: shortJwt(),
          cookie: 'session=new-session; New-Api-User=42',
          refresh_token: '',
          expires_at: 1761003600000,
          user_id: 42,
        },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761000000000 });
    assert.equal(report.updated.length, 1);
    assert.equal(report.updated[0].reason, 'not_overwriting_long_lived_token');

    const merged = readJson(target).accounts[0];
    assert.equal(merged.auth.token, 'sk-long-lived-api-key');
    assert.equal(merged.auth.expires_at, null);
    assert.equal(merged.auth.cookie, 'session=new-session; New-Api-User=42');
    assert.equal(merged.auth.user_id, 42);
    assert.equal(merged.captured_at, 1761000000000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('现有短命 JWT + 新短命 JWT：正常覆盖（回归）', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    const oldJwt = shortJwt({ exp: 1761000000 });
    writeJson(target, {
      version: 2,
      accounts: [
        longLivedAccount({ auth: { ...longLivedAccount().auth, token: oldJwt, expires_at: 1761000000000 } }),
      ],
    });

    const newJwt = shortJwt({ exp: 1761003600 });
    const input = captureFile(dir, [
      entry({
        site_type: 'newapi',
        auth: { mode: 'bearer', token: newJwt, cookie: '', refresh_token: '', expires_at: 1761003600000 },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761000000000 });
    assert.equal(report.updated.length, 1);
    assert.equal(report.updated[0].reason, null);
    assert.match(report.lines.join('\n'), /^~ demo:u1 /m);

    const merged = readJson(target).accounts[0];
    assert.equal(merged.auth.token, newJwt);
    assert.equal(merged.auth.expires_at, 1761003600000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sub2API 带 refresh_token：即使现有是长效 key 也正常覆盖（回归）', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, {
      version: 2,
      accounts: [longLivedAccount({ kind: 'sub2api', auth: { mode: 'bearer', token: 'sk-long-lived-api-key' } })],
    });

    const newJwt = shortJwt({ exp: 1761086400 });
    const input = captureFile(dir, [
      entry({
        auth: {
          mode: 'bearer',
          token: newJwt,
          cookie: '',
          refresh_token: 'refresh-24h',
          expires_at: 1761086400000,
        },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761000000000 });
    assert.equal(report.updated.length, 1);
    assert.equal(report.updated[0].reason, null);

    const merged = readJson(target).accounts[0];
    assert.equal(merged.auth.token, newJwt);
    assert.equal(merged.auth.refresh_token, 'refresh-24h');
    assert.equal(merged.auth.expires_at, 1761086400000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('目标里没有的账户：短命 JWT 也正常新增（回归，模拟只发长期 PAT 的上游）', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    writeJson(target, { version: 2, accounts: [longLivedAccount()] });

    const newJwt = shortJwt({ exp: 1761086400 });
    const input = captureFile(dir, [
      entry({
        site_name: 'legacy-key',
        site_url: 'https://legacy-key.test',
        account: { id: 'f1', name: 'bob', email: null },
        auth: {
          mode: 'bearer',
          token: newJwt,
          cookie: '',
          refresh_token: 'refresh-fast',
          expires_at: 1761086400000,
        },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761000000000 });
    assert.equal(report.added.length, 1);
    assert.equal(report.added[0].id, 'legacy-key:f1');
    assert.equal(report.added[0].reason, null);

    const saved = readJson(target);
    const created = saved.accounts.find((a) => a.id === 'legacy-key:f1');
    assert.equal(created.auth.token, newJwt);
    assert.equal(created.auth.cookie, '');
    assert.equal(saved.accounts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('保留长效 token 时报告也不出现 token / cookie 值', () => {
  const dir = tempDir();
  try {
    const target = configFile(dir);
    const longKey = 'SECRET-LONG-KEY-1';
    writeJson(target, {
      version: 2,
      accounts: [longLivedAccount({ auth: { ...longLivedAccount().auth, token: longKey } })],
    });

    const jwt = shortJwt({ sub: 'SECRET-ACCOUNT' });
    const cookie = 'session=SECRET-COOKIE-VALUE';
    const input = captureFile(dir, [
      entry({
        site_type: 'newapi',
        auth: { mode: 'bearer', token: jwt, cookie, refresh_token: '', expires_at: 1761003600000 },
        captured_at: 1761000000000,
      }),
    ]);

    const report = importCapture({ inputFile: input, configFile: target, now: 1761000000000 });
    const text = report.lines.join('\n');
    assert.ok(!text.includes(longKey));
    assert.ok(!text.includes(jwt));
    assert.ok(!text.includes(cookie));
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'));
    assert.match(text, /not_overwriting_long_lived_token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

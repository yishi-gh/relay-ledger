/**
 * collect-spend 集成单测：写入余额/入账窗口/明细/上报消费/任务记录，
 * 零充值 vs 未知、auth/429/缺 token、余额上升无入账。全部 mock fetch。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { runCollectSpend, recordInferredCredits } from '../jobs/collect-spend.mjs';
import { createApi } from '../lib/api.mjs';
import { loadConfig } from '../lib/config.mjs';
import { beijingDayStart, DAY_MS, dayKey } from '../lib/time.mjs';
import { initDashboardDb } from '../store/schema.mjs';
import {
  createMockFetch,
  jsonResponse,
  makeConfig,
  makeSourceDb,
  makeTempDir,
  newApiAccount,
  openTempDashboard,
  sub2ApiAccount,
} from './helpers/fixture.mjs';

const TOKEN = 'test-token';

function setup(accounts) {
  const dir = makeTempDir('v2-collect-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const dashboard = openTempDashboard(dir);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const config = makeConfig({ accounts });
  const api = createApi({
    source,
    dashboard,
    config,
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });
  return {
    dir,
    dashboard,
    config,
    api,
    cleanup() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function standardHandler(now) {
  return (u) => {
    if (u.pathname === '/api/user/self') return jsonResponse({ data: { quota: 500000 } });
    if (u.pathname === '/api/log/self') {
      if (u.searchParams.get('type') === '1') {
        return jsonResponse({
          data: {
            items: [{ id: 1, quota: 250000, created_at: Math.floor((now - 3600000) / 1000), content: '充值' }],
            total: 1,
          },
        });
      }
      return jsonResponse({ data: { items: [], total: 0 } });
    }
    if (u.pathname === '/api/log/self/stat') return jsonResponse({ data: { quota: 100000 } });
    if (u.pathname === '/api/v1/auth/me') return jsonResponse({ data: { balanceUsd: 20 } });
    if (u.pathname === '/api/v1/usage/stats') return jsonResponse({ data: { total_actual_cost: 1.5 } });
    throw new Error(`未预期的请求 ${u.pathname}`);
  };
}

test('正常采集：余额/入账窗口/明细/上报消费/任务记录都落库，零充值给 0', async () => {
  // 固定在北京时间当天中午，避免 00:00 后 1 小时内的 mock 充值落到“昨日”窗口
  const now = beijingDayStart(Date.now()) + 12 * 3600_000;
  const { dashboard, api, config, cleanup } = setup([newApiAccount(), sub2ApiAccount()]);
  const { fetchImpl } = createMockFetch(standardHandler(now));
  try {
    const summary = await runCollectSpend({
      config,
      db: dashboard,
      fetchImpl,
      now,
    });
    assert.equal(summary.status, 'ok');

    const snapshots = dashboard.prepare(
      'SELECT account_id, balance, currency, raw_balance, raw_unit FROM balance_snapshot ORDER BY account_id',
    ).all();
    assert.equal(snapshots.length, 2);
    const eula = snapshots.find((s) => s.account_id === 'eula');
    assert.equal(eula.balance, 1);
    assert.equal(eula.currency, 'USD');
    assert.equal(eula.raw_balance, 500000);
    assert.equal(eula.raw_unit, 'quota');
    const sub = snapshots.find((s) => s.account_id === '123api');
    assert.equal(sub.balance, 20);
    assert.equal(sub.raw_unit, 'USD');

    const events = dashboard.prepare(
      'SELECT account_id, amount, kind FROM credit_event ORDER BY account_id',
    ).all();
    assert.equal(events.length, 1);
    assert.equal(events[0].account_id, 'eula');
    assert.equal(events[0].amount, 0.5);
    assert.equal(events[0].kind, 'topup');
    // sub2api 充值 unsupported：不写任何明细，也不写 0
    assert.equal(events.filter((e) => e.account_id === '123api').length, 0);

    const dayStart = beijingDayStart(now);
    const windows = dashboard.prepare(
      'SELECT window_start, window_end, credits, status FROM credit_window WHERE account_id = ? ORDER BY window_start',
    ).all('eula');
    assert.equal(windows.length, 2);
    assert.equal(windows[0].window_start, dayStart - DAY_MS);
    assert.equal(windows[0].credits, 0); // 昨日完整日，确认零入账
    assert.equal(windows[0].status, 'complete');
    assert.equal(windows[1].window_start, dayStart);
    assert.equal(windows[1].credits, 0.5);
    assert.equal(windows[1].status, 'complete');

    const spend = dashboard.prepare(
      'SELECT account_id, day, spend FROM upstream_spend_daily ORDER BY account_id',
    ).all();
    assert.equal(spend.length, 2);
    assert.deepEqual(spend.map((s) => [s.account_id, s.spend]), [['123api', 1.5], ['eula', 0.2]]);
    assert.equal(spend[0].day, dayKey(now));

    const runs = dashboard.prepare('SELECT job, status, detail FROM job_runs').all();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].job, 'collect-spend');
    assert.ok(!runs[0].detail.includes(TOKEN));

    // 昨日完整日：credits 明确为 0（不是 null）
    const params = new URLSearchParams({
      from: String(dayStart - DAY_MS),
      to: String(dayStart - 1),
    });
    const [eulaAccount] = api.upstreams(params).accounts;
    assert.equal(eulaAccount.credits, 0);

    // 默认范围：今日入账、上报消费、最后同步与最近任务
    const [today] = api.upstreams(new URLSearchParams()).accounts;
    assert.equal(today.credits_today, 0.5);
    assert.equal(today.reported_spend_today, 0.2);
    assert.equal(today.last_sync, now);
    assert.equal(today.reported_consumption, 0.2);
    assert.equal(today.last_job.job, 'collect-spend');
    const subToday = api.upstreams(new URLSearchParams()).accounts[1];
    assert.equal(subToday.credits_today, null); // unsupported 不等于 0
    assert.equal(subToday.reported_spend_today, 1.5);

    const quality = api.quality();
    assert.equal(quality.jobs.never_run, false);
    assert.equal(quality.jobs.stalled, false);
    assert.equal(quality.jobs.last_status, 'ok');
  } finally {
    cleanup();
  }
});

test('缺 token：不请求、不写余额，标 missing_token', async () => {
  const account = newApiAccount({
    auth: { mode: 'bearer', token: '', refresh_token: '', token_env: null },
  });
  const { dashboard, config, cleanup } = setup([account]);
  const { fetchImpl, calls } = createMockFetch(() => {
    throw new Error('不应发起请求');
  });
  try {
    const summary = await runCollectSpend({
      config,
      db: dashboard,
      fetchImpl,
      now: Date.now(),
    });
    assert.equal(calls.length, 0);
    assert.equal(summary.status, 'partial');
    const [account] = summary.accounts;
    assert.equal(account.balance.reason, 'missing_token');
    assert.equal(account.credits.reason, 'missing_token');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM credit_window').get().n, 0);
  } finally {
    cleanup();
  }
});

test('429：停止整轮，后续账户不再请求', async () => {
  const { dashboard, config, cleanup } = setup([newApiAccount(), sub2ApiAccount()]);
  const { fetchImpl, calls } = createMockFetch(() => jsonResponse({}, 429));
  try {
    const summary = await runCollectSpend({
      config,
      db: dashboard,
      fetchImpl,
      now: Date.now(),
    });
    assert.equal(summary.status, 'rate_limited');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/user/self');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
    const run = dashboard.prepare('SELECT status, detail FROM job_runs').get();
    assert.equal(run.status, 'rate_limited');
    assert.ok(run.detail.includes('rate_limited'));
  } finally {
    cleanup();
  }
});

test('401：该账户 unavailable/auth_failed，且不再打后续接口', async () => {
  const { dashboard, config, cleanup } = setup([newApiAccount()]);
  const { fetchImpl, calls } = createMockFetch(() => jsonResponse({}, 401));
  try {
    const summary = await runCollectSpend({
      config,
      db: dashboard,
      fetchImpl,
      now: Date.now(),
    });
    assert.equal(summary.status, 'partial');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/user/self');
    const [account] = summary.accounts;
    assert.equal(account.balance.reason, 'auth_failed');
    assert.equal(account.credits.reason, 'auth_failed');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM credit_window').get().n, 0);
  } finally {
    cleanup();
  }
});

test('余额上升但上游入账为 0：上涨按 balance_delta 推断为充值，不计负消费', async () => {
  const now = Date.now();
  const dayStart = beijingDayStart(now);
  const { dashboard, api, config, cleanup } = setup([newApiAccount()]);
  dashboard.prepare(
    `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, raw_balance, raw_unit, source, recorded_at)
     VALUES ('eula', ?, ?, 100, 'USD', 50000000, 'quota', 'test', ?)`,
  ).run(dayStart, dayKey(dayStart), dayStart);

  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/user/self') return jsonResponse({ data: { quota: 60000000 } }); // 120 USD
    if (u.pathname === '/api/log/self') return jsonResponse({ data: { items: [], total: 0 } });
    if (u.pathname === '/api/log/self/stat') return jsonResponse({ data: { quota: 0 } });
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({
      config,
      db: dashboard,
      fetchImpl,
      now,
    });
    const [account] = summary.accounts;
    // 采集器本轮把它推断成 20 USD 充值，余额差被解释掉，不再报「余额上升无入账」
    assert.equal(account.written.inferred_credit, 20);
    assert.equal(account.ledger.status, 'partial');
    assert.equal(account.ledger.reason, 'incomplete_day');
    assert.equal(account.ledger.balance_delta, 0);
    assert.equal(account.ledger.consumption, 0);

    const params = new URLSearchParams({ from: String(dayStart), to: String(now) });
    const [today] = api.upstreams(params).accounts;
    assert.equal(today.reason, 'incomplete_day');
    assert.equal(today.balance_delta, 0);
    assert.equal(today.consumption, 0);
    assert.equal(today.margin, null);
    assert.equal(today.credits, 20);
  } finally {
    cleanup();
  }
});

function makeJwt(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

test('余额 401：强制换签一次并重试一次，成功后正常落库', async () => {
  const now = Date.now();
  const newToken = makeJwt({ exp: Math.floor((now + 3 * 3600 * 1000) / 1000) });
  const account = newApiAccount({
    auth: {
      mode: 'bearer',
      token: 'old-token',
      refresh_token: 'refresh-old',
      expires_at: null,
      token_env: null,
    },
  });
  const { dashboard, config, cleanup } = setup([account]);
  let balanceCalls = 0;
  let refreshCalls = 0;
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/v1/auth/refresh') {
      refreshCalls += 1;
      return jsonResponse({ data: { access_token: newToken, refresh_token: 'refresh-new', expires_in: 7200 } });
    }
    if (u.pathname === '/api/user/self') {
      balanceCalls += 1;
      return balanceCalls === 1 ? jsonResponse({}, 401) : jsonResponse({ data: { quota: 500000 } });
    }
    if (u.pathname === '/api/log/self') return jsonResponse({ data: { items: [], total: 0 } });
    if (u.pathname === '/api/log/self/stat') return jsonResponse({ data: { quota: 0 } });
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    assert.equal(balanceCalls, 2);
    assert.equal(refreshCalls, 1);
    const [acc] = summary.accounts;
    assert.equal(acc.balance.status, 'ok');
    assert.equal(acc.refresh.forced, true);
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 1);

    const detail = dashboard.prepare('SELECT detail FROM job_runs').get().detail;
    assert.ok(!detail.includes('old-token'));
    assert.ok(!detail.includes('refresh-new'));
    assert.ok(!detail.includes(newToken));
  } finally {
    cleanup();
  }
});

test('到期前自动换签并写回单文件，其他账户保持原样', async () => {
  const now = Date.now();
  const dir = makeTempDir('v2-collect-auth-');
  const newToken = makeJwt({ exp: Math.floor((now + 3 * 3600 * 1000) / 1000) });
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        upstream: { min_interval_ms: 0, retry_delay_ms: 0, timeout_ms: 5000 },
        accounts: [
          {
            id: 'eula',
            name: 'eula',
            kind: 'newapi',
            base_url: 'https://newapi.test',
            auth: {
              mode: 'bearer',
              token: 'expiring-token',
              refresh_token: 'refresh-old',
              expires_at: now + 60 * 1000,
              token_env: null,
            },
            endpoints: { balance: '/api/user/self', credits: '/api/log/self', usage: '/api/log/self/stat' },
            quota_per_unit: 500000,
            channels: [27],
          },
          {
            id: 'other',
            name: 'other',
            kind: 'sub2api',
            base_url: 'https://other.test',
            auth: { mode: 'bearer', token: 'other-token', refresh_token: 'other-refresh' },
            channels: [13],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const config = loadConfig(file, { writable: true });
  const dashboard = openTempDashboard(dir);
  try {
    const { fetchImpl, calls } = createMockFetch((u) => {
      if (u.pathname === '/api/v1/auth/refresh') {
        return jsonResponse({ data: { access_token: newToken, refresh_token: 'refresh-new', expires_in: 10800 } });
      }
      if (u.pathname === '/api/user/self') return jsonResponse({ data: { quota: 500000 } });
      if (u.pathname === '/api/log/self') return jsonResponse({ data: { items: [], total: 0 } });
      if (u.pathname === '/api/log/self/stat') return jsonResponse({ data: { quota: 0 } });
      throw new Error(`未预期的请求 ${u.pathname}`);
    });
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    assert.equal(summary.accounts[0].refresh.refreshed, true);
    assert.equal(calls.filter((c) => c.path === '/api/v1/auth/refresh').length, 1);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const eula = saved.accounts.find((a) => a.id === 'eula');
    assert.equal(eula.auth.token, newToken);
    assert.equal(eula.auth.refresh_token, 'refresh-new');
    assert.ok(eula.auth.expires_at > now);
    const other = saved.accounts.find((a) => a.id === 'other');
    assert.equal(other.auth.token, 'other-token');
    assert.equal(other.auth.refresh_token, 'other-refresh');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('expiring-token'));
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('换签失败：auth_failed，不写余额也不泄露 token', async () => {
  const now = Date.now();
  const account = newApiAccount({
    auth: {
      mode: 'bearer',
      token: 'stale-access',
      refresh_token: 'refresh-old',
      expires_at: null,
      token_env: null,
    },
  });
  const { dashboard, config, cleanup } = setup([account]);
  let balanceCalls = 0;
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/v1/auth/refresh') return jsonResponse({}, 401);
    if (u.pathname === '/api/user/self') {
      balanceCalls += 1;
      return jsonResponse({}, 401);
    }
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    assert.equal(balanceCalls, 1);
    const [acc] = summary.accounts;
    assert.equal(acc.balance.reason, 'auth_failed');
    assert.equal(acc.credits.reason, 'auth_failed');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
    const detail = dashboard.prepare('SELECT detail FROM job_runs').get().detail;
    assert.ok(!detail.includes('stale-access'));
    assert.ok(!detail.includes('refresh-old'));
    assert.ok(!detail.includes('refresh_unauthorized'));
  } finally {
    cleanup();
  }
});

function cookieJsonResponse(body, setCookies = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of setCookies) headers.append('set-cookie', value);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function newApiCookieConfig(dir, { user_id = 7, cookie = 'session=old; refresh=r1' } = {}) {
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        upstream: { min_interval_ms: 0, retry_delay_ms: 0, timeout_ms: 5000 },
        accounts: [
          {
            id: 'eula',
            name: 'eula',
            kind: 'newapi',
            base_url: 'https://newapi.test',
            auth: { mode: 'cookie', cookie, token: 'old-token', user_id, token_env: null },
            endpoints: { balance: '/api/user/self', credits: '/api/log/self', usage: '/api/log/self/stat' },
            quota_per_unit: 500000,
            channels: [27],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { file, config: loadConfig(file, { writable: true }) };
}

test('NewAPI 余额 401：用 cookie 换签后重试成功，并写回 token/cookie', async () => {
  const now = Date.now();
  const dir = makeTempDir('v2-collect-cookie-');
  const newToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor((now + 900_000) / 1000) });
  const { file, config } = newApiCookieConfig(dir);
  const dashboard = openTempDashboard(dir);
  let balanceCalls = 0;
  let refreshCalls = 0;
  const { fetchImpl } = createMockFetch((u, init) => {
    if (u.pathname === '/api/user/auth/refresh') {
      refreshCalls += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Cookie, 'session=old; refresh=r1');
      return cookieJsonResponse(
        { success: true, data: { access_token: newToken, user: { id: 7 } } },
        ['session=new; Path=/; HttpOnly'],
      );
    }
    if (u.pathname === '/api/user/self') {
      balanceCalls += 1;
      return balanceCalls === 1
        ? jsonResponse({}, 401)
        : jsonResponse({ success: true, data: { id: 7, quota: 500000 } });
    }
    if (u.pathname === '/api/log/self') return jsonResponse({ success: true, data: { items: [], total: 0 } });
    if (u.pathname === '/api/log/self/stat') return jsonResponse({ success: true, data: { quota: 100000 } });
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    assert.equal(balanceCalls, 2);
    assert.equal(refreshCalls, 1);
    const [acc] = summary.accounts;
    assert.equal(acc.balance.status, 'ok');
    assert.equal(acc.refresh.forced, true);
    assert.equal(acc.refresh.wrote, true);
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 1);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.accounts[0].auth.token, newToken);
    assert.equal(saved.accounts[0].auth.cookie, 'session=new; refresh=r1');

    const detail = dashboard.prepare('SELECT detail FROM job_runs').get().detail;
    assert.ok(!detail.includes(newToken));
    assert.ok(!detail.includes('session=old'));
    assert.ok(!detail.includes('session=new'));
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NewAPI 401 且没有 cookie / refresh_token：不换签，auth_failed', async () => {
  const account = newApiAccount({
    auth: { mode: 'bearer', token: 'stale-access', cookie: null, refresh_token: null, token_env: null },
  });
  const { dashboard, config, cleanup } = setup([account]);
  const { fetchImpl, calls } = createMockFetch(() => jsonResponse({}, 401));
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now: Date.now() });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/user/self');
    const [acc] = summary.accounts;
    assert.equal(acc.balance.reason, 'auth_failed');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
  } finally {
    cleanup();
  }
});

test('NewAPI cookie 模式但没有 cookie：不请求，标 missing_cookie', async () => {
  const account = newApiAccount({
    auth: { mode: 'cookie', cookie: null, token: '', refresh_token: null, token_env: null },
  });
  const { dashboard, config, cleanup } = setup([account]);
  const { fetchImpl, calls } = createMockFetch(() => {
    throw new Error('不应发起请求');
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now: Date.now() });
    assert.equal(calls.length, 0);
    const [acc] = summary.accounts;
    assert.equal(acc.balance.reason, 'missing_cookie');
    assert.equal(acc.credits.reason, 'missing_cookie');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
  } finally {
    cleanup();
  }
});

test('NewAPI 换签返回非 JWT：auth_failed，不写余额也不泄露凭据', async () => {
  const account = newApiAccount({
    auth: { mode: 'cookie', cookie: 'session=old; refresh=r1', token: 'stale-access', user_id: 7, token_env: null },
  });
  const { dashboard, config, cleanup } = setup([account]);
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/user/auth/refresh') {
      return jsonResponse({ success: true, data: { access_token: 'opaque-token', user: { id: 7 } } });
    }
    if (u.pathname === '/api/user/self') return jsonResponse({}, 401);
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now: Date.now() });
    const [acc] = summary.accounts;
    assert.equal(acc.balance.reason, 'auth_failed');
    assert.equal(acc.credits.reason, 'auth_failed');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
    const detail = dashboard.prepare('SELECT detail FROM job_runs').get().detail;
    assert.ok(!detail.includes('opaque-token'));
    assert.ok(!detail.includes('stale-access'));
    assert.ok(!detail.includes('session=old'));
  } finally {
    cleanup();
  }
});

test('NewAPI 换签返回别人的 user.id：cookie_account_mismatch，不写余额也不写回', async () => {
  const now = Date.now();
  const dir = makeTempDir('v2-collect-mismatch-');
  const foreignToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor((now + 900_000) / 1000) });
  const { file, config } = newApiCookieConfig(dir);
  const dashboard = openTempDashboard(dir);
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/user/auth/refresh') {
      return cookieJsonResponse({ success: true, data: { access_token: foreignToken, user: { id: 8 } } }, ['session=other; Path=/']);
    }
    if (u.pathname === '/api/user/self') return jsonResponse({}, 401);
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    const [acc] = summary.accounts;
    assert.equal(acc.balance.reason, 'cookie_account_mismatch');
    assert.equal(acc.credits.reason, 'cookie_account_mismatch');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.accounts[0].auth.token, 'old-token');
    assert.equal(saved.accounts[0].auth.cookie, 'session=old; refresh=r1');
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NewAPI 余额返回别的 user.id：cookie_account_mismatch，不再请求后续接口', async () => {
  const account = newApiAccount({
    auth: { mode: 'cookie', cookie: 'session=other-account', token: '', user_id: 7, token_env: null },
  });
  const { dashboard, config, cleanup } = setup([account]);
  const { fetchImpl, calls } = createMockFetch(() =>
    jsonResponse({ success: true, data: { id: 8, quota: 500000 } }),
  );
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now: Date.now() });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/user/self');
    const [acc] = summary.accounts;
    assert.equal(acc.balance.reason, 'cookie_account_mismatch');
    assert.equal(acc.spend.reason, 'cookie_account_mismatch');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 0);
  } finally {
    cleanup();
  }
});

test('NewAPI 主动换签失败但旧 token 仍可用：软失败继续采集，detail 记 refresh_error', async () => {
  const now = Date.now();
  const account = newApiAccount({
    auth: {
      mode: 'cookie',
      cookie: 'session=still-valid',
      token: makeJwt({ iat: Math.floor(now / 1000) - 840, exp: Math.floor(now / 1000) + 60 }),
      user_id: 7,
      token_env: null,
    },
  });
  const { dashboard, config, cleanup } = setup([account]);
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/user/auth/refresh') return jsonResponse({}, 500);
    if (u.pathname === '/api/user/self') return jsonResponse({ success: true, data: { id: 7, quota: 500000 } });
    if (u.pathname === '/api/log/self') return jsonResponse({ success: true, data: { items: [], total: 0 } });
    if (u.pathname === '/api/log/self/stat') return jsonResponse({ success: true, data: { quota: 0 } });
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    const [acc] = summary.accounts;
    assert.equal(acc.balance.status, 'ok');
    assert.equal(acc.refresh.refreshed, false);
    assert.equal(acc.refresh.refresh_error, 'refresh_failed');
    assert.equal(dashboard.prepare('SELECT COUNT(*) n FROM balance_snapshot').get().n, 1);
    const detail = dashboard.prepare('SELECT detail FROM job_runs').get().detail;
    assert.ok(!detail.includes('still-valid'));
  } finally {
    cleanup();
  }
});

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  initDashboardDb(db);
  return db;
}

function insertCredit(db, accountId, tMs, amount, source = 'collect-spend') {
  db.prepare(
    'INSERT INTO credit_event (account_id, t_ms, amount, kind, note, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(accountId, tMs, amount, 'topup', null, source, tMs);
}

test('推断充值：余额上升 10、已有 NewAPI 充值 3 → 补 7', () => {
  const db = memoryDb();
  try {
    insertCredit(db, 'acc', 1500, 3);
    const result = recordInferredCredits(
      db,
      'acc',
      { t_ms: 1000, balance: 100 },
      { t_ms: 2000, balance: 110 },
      2000,
    );
    assert.deepEqual(result, { inserted: true, amount: 7 });
    const rows = db.prepare(
      "SELECT t_ms, amount, kind, source, note FROM credit_event WHERE source = 'balance_delta'",
    ).all();
    assert.equal(rows.length, 1);
    // 推断金额落在区间内部（期初快照之后），避免被分到下一个小时桶
    assert.equal(rows[0].t_ms, 1001);
    assert.equal(rows[0].amount, 7);
    assert.equal(rows[0].kind, 'topup');
    assert.equal(rows[0].note, 'inferred from balance rise');
  } finally {
    db.close();
  }
});

test('推断充值：余额上升 10、已有充值 12 → 不推断', () => {
  const db = memoryDb();
  try {
    insertCredit(db, 'acc', 1500, 12);
    const result = recordInferredCredits(
      db,
      'acc',
      { t_ms: 1000, balance: 100 },
      { t_ms: 2000, balance: 110 },
      2000,
    );
    assert.deepEqual(result, { inserted: false, amount: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_event WHERE source = 'balance_delta'").get().n, 0);
  } finally {
    db.close();
  }
});

test('推断充值：余额下降或不变不记负充值', () => {
  const db = memoryDb();
  try {
    assert.deepEqual(
      recordInferredCredits(db, 'acc', { t_ms: 1000, balance: 100 }, { t_ms: 2000, balance: 90 }, 2000),
      { inserted: false, amount: 0 },
    );
    assert.deepEqual(
      recordInferredCredits(db, 'acc', { t_ms: 1000, balance: 100 }, { t_ms: 2000, balance: 100 }, 2000),
      { inserted: false, amount: 0 },
    );
    // 没有上一条快照也不推断
    assert.deepEqual(
      recordInferredCredits(db, 'acc', null, { t_ms: 2000, balance: 110 }, 2000),
      { inserted: false, amount: 0 },
    );
    assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_event').get().n, 0);
  } finally {
    db.close();
  }
});

test('推断充值：重复调用不重复插入', () => {
  const db = memoryDb();
  try {
    insertCredit(db, 'acc', 1500, 3);
    const args = [db, 'acc', { t_ms: 1000, balance: 100 }, { t_ms: 2000, balance: 110 }, 2000];
    assert.deepEqual(recordInferredCredits(...args), { inserted: true, amount: 7 });
    // 第二次时区间内已含推断出的 7，剩余为 0
    assert.deepEqual(recordInferredCredits(...args), { inserted: false, amount: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM credit_event WHERE source = 'balance_delta'").get().n, 1);
  } finally {
    db.close();
  }
});

test('推断充值：同一 (account, balance_delta, t_ms) 已存在时不覆盖', () => {
  const db = memoryDb();
  try {
    // 推断金额固定记在期初快照之后 1ms
    insertCredit(db, 'acc', 1001, 7, 'balance_delta');
    assert.deepEqual(
      recordInferredCredits(db, 'acc', { t_ms: 1000, balance: 100 }, { t_ms: 2000, balance: 110 }, 2000),
      { inserted: false, amount: 0 },
    );
    const rows = db.prepare("SELECT amount FROM credit_event WHERE source = 'balance_delta'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 7);
  } finally {
    db.close();
  }
});

test('采集后推断充值：余额上升 10、已记录 NewAPI 充值 3 → 补 7', async () => {
  const now = beijingDayStart(Date.now()) + 12 * 3600_000;
  const { dashboard, config, cleanup } = setup([newApiAccount()]);
  dashboard.prepare(
    `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, raw_balance, raw_unit, source, recorded_at)
     VALUES ('eula', ?, ?, 100, 'USD', 50000000, 'quota', 'test', ?)`,
  ).run(now - 3600_000, dayKey(now - 3600_000), now - 3600_000);

  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/user/self') return jsonResponse({ data: { quota: 55000000 } });
    if (u.pathname === '/api/log/self') {
      if (u.searchParams.get('type') === '1') {
        return jsonResponse({
          data: {
            items: [{ id: 1, quota: 1500000, created_at: Math.floor((now - 1800_000) / 1000), content: '充值' }],
            total: 1,
          },
        });
      }
      return jsonResponse({ data: { items: [], total: 0 } });
    }
    if (u.pathname === '/api/log/self/stat') return jsonResponse({ data: { quota: 0 } });
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now });
    assert.equal(summary.accounts[0].written.inferred_credit, 7);
    const rows = dashboard.prepare(
      "SELECT amount, kind, source, note FROM credit_event WHERE account_id = 'eula' ORDER BY amount",
    ).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].amount, 3);
    assert.equal(rows[0].source, 'collect-spend');
    assert.equal(rows[1].amount, 7);
    assert.equal(rows[1].kind, 'topup');
    assert.equal(rows[1].source, 'balance_delta');
    assert.equal(rows[1].note, 'inferred from balance rise');
  } finally {
    cleanup();
  }
});

test('session:false 的账户只用渠道 key 取余额：入账与上报消费记为未配置，整轮仍为 ok', async () => {
  const now = beijingDayStart(Date.now()) + 12 * 3600_000;
  const dir = makeTempDir('v2-collect-keyonly-');
  const relayFile = path.join(dir, 'relay.db');
  const relay = new DatabaseSync(relayFile);
  relay.exec('CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, key TEXT, base_url TEXT)');
  relay.prepare('INSERT INTO channels (id, name, key, base_url) VALUES (?, ?, ?, ?)')
    .run(36, 'FastAI Gemini', 'sk-fixture', 'https://relay.test');
  relay.close();

  const dashboard = openTempDashboard(dir);
  const config = makeConfig({
    accounts: [sub2ApiAccount({ id: 'fastai', name: 'fastai', channels: [36], session: false })],
  });
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/v1/usage') return jsonResponse({ balance: 5.5, unit: 'USD' });
    throw new Error(`不应请求 ${u.pathname}`);
  });

  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now, relayDbFile: relayFile });
    assert.equal(summary.status, 'ok');
    assert.equal(summary.accounts.length, 1);
    const account = summary.accounts[0];
    assert.equal(account.status, 'ok');
    assert.equal(account.balance_source, 'channel_key');
    assert.equal(account.balance.status, 'ok');
    // 没有会话就没有入账/上报消费的数据源，这不是采集失败
    assert.equal(account.credits.status, 'unconfigured');
    assert.equal(account.credits.reason, 'not_configured');
    assert.equal(account.spend.status, 'unconfigured');
    assert.equal(account.ledger.status, 'unconfigured');

    const snap = dashboard.prepare('SELECT balance, source FROM balance_snapshot').get();
    assert.equal(snap.balance, 5.5);
    assert.equal(snap.source, 'collect-spend');
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig 保留 session:false，缺省时为 true', () => {
  const dir = makeTempDir('v2-config-session-');
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({
    accounts: [
      { id: 'keyonly', kind: 'sub2api', base_url: 'https://a.test', session: false },
      { id: 'normal', kind: 'newapi', base_url: 'https://b.test' },
    ],
  }));
  try {
    const config = loadConfig(file, { writable: false });
    const byId = new Map(config.accounts.map((a) => [a.id, a]));
    assert.equal(byId.get('keyonly').session, false);
    assert.equal(byId.get('normal').session, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话失效但渠道 key 拿到余额：账户仍是 ok，不算采集失败', async () => {
  const now = Date.now();
  const dir = makeTempDir('v2-collect-keyfallback-');
  const relayFile = path.join(dir, 'relay.db');
  const relay = new DatabaseSync(relayFile);
  relay.exec('CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, key TEXT, base_url TEXT)');
  relay.prepare('INSERT INTO channels (id, name, key, base_url) VALUES (?, ?, ?, ?)')
    .run(27, 'GPT C2.1 EULA', 'sk-fixture', 'https://relay.test');
  relay.close();

  const dashboard = openTempDashboard(dir);
  const account = sub2ApiAccount({
    id: 'eula',
    name: 'eula',
    channels: [27],
    auth: { mode: 'bearer', token: 'stale-access', refresh_token: 'refresh-old', expires_at: 1, token_env: null },
  });
  const config = makeConfig({ accounts: [account] });
  const { fetchImpl } = createMockFetch((u) => {
    if (u.pathname === '/api/v1/auth/refresh') return jsonResponse({}, 401);
    if (u.pathname === '/v1/usage') return jsonResponse({ balance: 9.5, unit: 'USD' });
    throw new Error(`不应请求 ${u.pathname}`);
  });

  try {
    const summary = await runCollectSpend({ config, db: dashboard, fetchImpl, now, relayDbFile: relayFile });
    // 入账/上报消费确实取不到，但余额是真的——不能因此把整轮报成失败
    assert.equal(summary.status, 'ok');
    const acc = summary.accounts[0];
    assert.equal(acc.status, 'ok');
    assert.equal(acc.balance.status, 'ok');
    assert.equal(acc.balance_source, 'channel_key');
    // 入账这一路取不到（会话失效或 sub2api 没有充值接口），但不能影响账户状态
    assert.ok(acc.credits.reason);
    const snap = dashboard.prepare('SELECT balance FROM balance_snapshot').get();
    assert.equal(snap.balance, 9.5);
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

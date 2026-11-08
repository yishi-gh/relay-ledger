/**
 * 测试共用夹具：临时库、mock fetch、配置。不属于测试用例，文件名不带 .test。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDashboardDb } from '../../store/dashboard.mjs';

export function makeTempDir(prefix = 'v2-test-') {
  return fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMP ?? '.', prefix));
}

export function makeSourceDb(file, { rows = [] } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE logs (
      req_id TEXT PRIMARY KEY, t_ms INTEGER NOT NULL, t_local TEXT NOT NULL,
      channel_id INTEGER, channel_name TEXT, model TEXT, token_name TEXT,
      cost REAL, quota_raw INTEGER, input_total INTEGER, input_uncached INTEGER,
      cache_read INTEGER, cache_write INTEGER, output INTEGER,
      latency_ms INTEGER, first_token_ms INTEGER, log_type INTEGER
    );
    CREATE TABLE error_logs (t_ms INTEGER, status_code INTEGER);
  `);
  const ins = db.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES (?, ?, ?, ?, ?, 'm', ?, ?, 0, 10, 10, 0, 0, 5, 1000, 1000, ?)`,
  );
  for (const row of rows) {
    ins.run(
      row.req_id,
      row.t_ms,
      'test',
      row.channel_id ?? 13,
      row.channel_name ?? '渠道一',
      row.token_name ?? 't1',
      row.cost ?? 0,
      row.log_type ?? 2,
    );
  }
  db.close();
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录调用（path/search/headers）并按 handler 返回 Response */
export function createMockFetch(handler) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = url instanceof URL ? url : new URL(String(url));
    const record = {
      method: init.method ?? 'GET',
      path: u.pathname,
      search: u.searchParams,
      headers: init.headers ?? {},
    };
    calls.push(record);
    return handler(u, init, record);
  }
  return { fetchImpl, calls };
}

export function makeConfig({ accounts, upstream = {} } = {}) {
  return {
    currency: 'USD',
    quota_per_unit: 500000,
    upstream: {
      timeout_ms: 20000,
      min_interval_ms: 0,
      retry_delay_ms: 0,
      job_stale_ms: 1800000,
      ...upstream,
    },
    accounts,
  };
}

export function newApiAccount(overrides = {}) {
  return {
    id: 'eula',
    name: 'eula',
    kind: 'newapi',
    base_url: 'https://newapi.test',
    unit: 'USD',
    enabled: true,
    channels: [27],
    auth: {
      mode: 'bearer',
      token: 'test-token',
      cookie: null,
      refresh_token: null,
      expires_at: null,
      user_id: null,
      token_env: 'TEST_EULA_TOKEN',
      header: 'Authorization',
      scheme: 'Bearer',
      headers: {},
    },
    endpoints: {
      balance: '/api/user/self',
      credits: '/api/log/self',
      usage: '/api/log/self/stat',
    },
    quota_per_unit: 500000,
    ...overrides,
  };
}

export function sub2ApiAccount(overrides = {}) {
  return {
    id: '123api',
    name: '123api',
    kind: 'sub2api',
    base_url: 'https://sub2api.test',
    unit: 'USD',
    enabled: true,
    channels: [13],
    auth: {
      mode: 'bearer',
      token: 'test-token',
      cookie: null,
      refresh_token: null,
      expires_at: null,
      user_id: null,
      token_env: 'TEST_123API_TOKEN',
      header: 'Authorization',
      scheme: 'Bearer',
      headers: {},
    },
    endpoints: {
      balance: '/api/v1/auth/me',
      usage: '/api/v1/usage/stats?period=today',
    },
    quota_per_unit: null,
    ...overrides,
  };
}

export function openTempDashboard(dir) {
  return openDashboardDb(path.join(dir, 'dashboard.db'));
}

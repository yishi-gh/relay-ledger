/**
 * collect-alerts：连续 partial、channel-state 失败、余额陈旧、未映射收入，
 * 以及 alert_state 去重和 webhook payload 不含凭据。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { runCollectAlerts } from '../jobs/collect-alerts.mjs';
import { createApi } from '../lib/api.mjs';
import { listActiveAlerts, markAlertsSent, syncAlertState } from '../store/alerts.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeConfig, makeSourceDb, makeTempDir, sub2ApiAccount } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const HOUR = 3_600_000;

function setup() {
  const dir = makeTempDir('v2-alerts-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile, {
    rows: [
      { req_id: 'r47', t_ms: NOW - HOUR, channel_id: 47, channel_name: 'Sub2API', cost: 5 },
      { req_id: 'r48', t_ms: NOW - HOUR, channel_id: 48, channel_name: 'Gemini 按次', cost: 5 },
    ],
  });
  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  dashboard.prepare(
    `INSERT INTO channel_state (channel_id, name, status, base_url, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(47, '鸡出没 kimi', 1, 'https://xcmapi.org', NOW);
  dashboard.prepare(
    `INSERT INTO channel_state (channel_id, name, status, base_url, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(48, 'Gemini 按次', 1, 'https://other.example.com', NOW);

  const run = dashboard.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 4; i += 1) {
    run.run('collect-spend', NOW - (i + 1) * 15 * 60_000, NOW - (i + 1) * 15 * 60_000 + 1000, 'partial', JSON.stringify({
      accounts: [{ id: 'xcmapi', name: '鸡出没API', status: 'unavailable', reason: 'network_error' }],
    }));
  }
  run.run('channel-state', NOW - 5 * 60_000, NOW - 5 * 60_000 + 100, 'error', JSON.stringify({
    message: '源库不存在：/tmp/missing.db',
  }));

  const config = makeConfig({
    accounts: [sub2ApiAccount({
      id: 'xcmapi',
      name: '鸡出没API',
      base_url: 'https://www.xcmapi.com',
      channels: [34, 40],
      session: false,
      auth: {
        mode: 'bearer',
        token: 'must-not-leak',
        cookie: null,
        refresh_token: null,
        expires_at: null,
        user_id: null,
        token_env: null,
      },
    })],
  });

  return {
    dashboard,
    source: sourceDb,
    config,
    close() {
      sourceDb.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('告警：四类信号去重投递，payload 不含凭据', async () => {
  const fx = setup();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('', { status: 200 });
  };
  try {
    const first = await runCollectAlerts({
      dashboard: fx.dashboard,
      source: fx.source,
      config: fx.config,
      now: NOW,
      fetchImpl,
      webhookUrl: 'https://hooks.test/relay',
    });
    assert.equal(first.webhook_configured, true);
    assert.equal(first.pending, 4);
    assert.equal(first.sent, 4);
    assert.equal(first.send_failed, false);
    assert.equal(calls.length, 1);
    const keys = calls[0].body.alerts.map((a) => a.key).sort();
    assert.deepEqual(keys, [
      'balance-stale:xcmapi',
      'channel-state-error',
      'collect-spend-partial',
      'unmapped-channel:48',
    ]);
    assert.equal(JSON.stringify(calls[0].body).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(calls[0].body).includes('sk-'), false);

    const api = createApi({
      source: fx.source,
      dashboard: fx.dashboard,
      config: fx.config,
      siteName: 't',
      sourceLabel: 's',
      now: () => NOW,
    });
    assert.equal(api.quality().alerts.length, 4);

    const second = await runCollectAlerts({
      dashboard: fx.dashboard,
      source: fx.source,
      config: fx.config,
      now: NOW + 1000,
      fetchImpl,
      webhookUrl: 'https://hooks.test/relay',
    });
    assert.equal(second.pending, 0);
    assert.equal(second.sent, 0);
    assert.equal(calls.length, 1, '同一告警 24h 内不重复投递');
    assert.equal(fx.dashboard.prepare('SELECT COUNT(*) n FROM alert_state WHERE resolved_at IS NULL').get().n, 4);
  } finally {
    fx.close();
  }
});

test('告警：未配置 webhook 时只落库，不发起外部请求', async () => {
  const fx = setup();
  let called = 0;
  try {
    const summary = await runCollectAlerts({
      dashboard: fx.dashboard,
      source: fx.source,
      config: fx.config,
      now: NOW,
      fetchImpl: async () => {
        called += 1;
        return new Response('', { status: 200 });
      },
      webhookUrl: '',
    });
    assert.equal(summary.webhook_configured, false);
    assert.equal(summary.pending, 4);
    assert.equal(summary.sent, 0);
    assert.equal(called, 0);
    assert.equal(fx.dashboard.prepare('SELECT COUNT(*) n FROM alert_state WHERE resolved_at IS NULL').get().n, 4);
  } finally {
    fx.close();
  }
});

test('alert_state：消失即 resolved，重新出现会重新投递', () => {
  const dir = makeTempDir('v2-alert-state-');
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const alert = { key: 'channel-state-error', severity: 'error', title: '渠道状态同步失败', detail: 'x' };
  try {
    const first = syncAlertState(dashboard, [alert], { now: 1000, repeatMs: 60_000 });
    assert.equal(first.length, 1);
    markAlertsSent(dashboard, ['channel-state-error'], 1000);
    assert.equal(syncAlertState(dashboard, [alert], { now: 2000, repeatMs: 60_000 }).length, 0);

    assert.equal(syncAlertState(dashboard, [], { now: 3000 }).length, 0);
    assert.deepEqual(listActiveAlerts(dashboard), []);

    const again = syncAlertState(dashboard, [alert], { now: 4000, repeatMs: 60_000 });
    assert.equal(again.length, 1, '恢复后重新出现必须重新投递');
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

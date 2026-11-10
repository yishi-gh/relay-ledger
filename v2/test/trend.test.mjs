/**
 * /api/trend 每桶 Token 与缓存率：单次聚合、按分母加权、0 分母为 null。
 * 明细库与看板库均建在临时目录，测完删除。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createApi } from '../lib/api.mjs';
import { beijingDayStart, DAY_MS, dayKey, formatLocal } from '../lib/time.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { LOGS_SCHEMA } from '../store/site-logs.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

function params(obj) {
  return new URLSearchParams(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)])));
}

function hourLabel(ms) {
  return `${formatLocal(ms).slice(0, 13)}:00`;
}

test('trend：tokens 合计与 cache_rate 按桶分母加权，0 分母为 null', async (t) => {
  const dir = makeTempDir('v2-trend-');
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');
  const base = beijingDayStart(Date.now() - 2 * DAY_MS);

  const source = new DatabaseSync(sourceFile);
  source.exec(LOGS_SCHEMA);
  const ins = source.prepare(
    `INSERT INTO logs (req_id, site, source_kind, input_format, t_ms, t_local, token_name,
                       channel_id, channel_name, cost, quota_raw, input_total, input_uncached,
                       cache_read, cache_write, output, latency_ms, log_type, raw_json)
     VALUES (?, 'relay', 'api', 'openai', ?, '2026-11-02 12:00:00', 't1',
             13, '渠道一', ?, ?, ?, ?, ?, 0, ?, 1000, 2, '')`,
  );
  // 09:00 桶：两条不同分母，加权 200/300，而不是 (0.2+0.9)/2
  ins.run('r1', base + 9 * 3600000 + 10 * 60000, 1, 100, 100, 80, 20, 10);
  ins.run('r2', base + 9 * 3600000 + 45 * 60000, 2, 200, 200, 20, 180, 20);
  // 10:00 桶：cache_read=0、input_uncached>0，缓存率为 0
  ins.run('r3', base + 10 * 3600000 + 5 * 60000, 4, 400, 50, 50, 0, 5);
  // 11:00 桶：分母为 0，缓存率为 null
  ins.run('r4', base + 11 * 3600000 + 5 * 60000, 8, 800, 10, 0, 0, 5);
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const api = createApi({
    source: sourceDb,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'relay',
    sourceLabel: 'db/sites/relay.db',
  });

  t.after(() => {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const range = { from: base + 8 * 3600000, to: base + 12 * 3600000 };

  await t.test('hour：逐桶 tokens 与分母加权 cache_rate', () => {
    const data = api.trend(params({ ...range, granularity: 'hour' }));
    assert.equal(data.archive.available, false);
    assert.deepEqual(data.archive.partial_fields, []);
    assert.deepEqual(data.points, [
      {
        bucket: hourLabel(base + 9 * 3600000),
        revenue: 3,
        quota: 300,
        requests: 2,
        tokens: 330,
        cache_rate: 0.666667,
      },
      {
        bucket: hourLabel(base + 10 * 3600000),
        revenue: 4,
        quota: 400,
        requests: 1,
        tokens: 55,
        cache_rate: 0,
      },
      {
        bucket: hourLabel(base + 11 * 3600000),
        revenue: 8,
        quota: 800,
        requests: 1,
        tokens: 15,
        cache_rate: null,
      },
    ]);
  });

  await t.test('day：明细日汇总同样按分母加权，收入/请求口径不变', () => {
    const data = api.trend(params({ ...range, granularity: 'day' }));
    assert.deepEqual(data.points, [
      {
        bucket: dayKey(base),
        revenue: 15,
        quota: 1500,
        requests: 4,
        tokens: 400,
        cache_rate: 0.571429,
      },
    ]);
  });
});

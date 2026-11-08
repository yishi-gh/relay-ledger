/**
 * 分位数下推 SQL 的边界与对拍：结果必须与改造前的 JS percentile()（R-7 线性插值、一位小数）逐位一致。
 * 源库与看板库都建在临时目录，测完删除。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createApi } from '../lib/api.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';

/** 改造前 api.mjs 里的实现，仅作对拍基线 */
function jsPercentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(value * 10) / 10;
}

const FROM = 1_700_000_000_000;
const TO = FROM + 30 * 24 * 3600 * 1000;

function query(obj) {
  return new URLSearchParams({ from: String(FROM), to: String(TO), ...obj });
}

/** rows: [{ channelId, latency, cost? }]，latency 为 null 表示该行没有延迟 */
function makeApi(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-pct-'));
  const sourceFile = path.join(dir, 'source.db');
  const seed = new DatabaseSync(sourceFile);
  seed.exec(`
    CREATE TABLE logs (
      req_id TEXT PRIMARY KEY, t_ms INTEGER NOT NULL, t_local TEXT NOT NULL,
      channel_id INTEGER, channel_name TEXT, model TEXT, token_name TEXT,
      cost REAL, quota_raw INTEGER, input_total INTEGER, input_uncached INTEGER,
      cache_read INTEGER, cache_write INTEGER, output INTEGER,
      latency_ms INTEGER, first_token_ms INTEGER, log_type INTEGER
    );
    CREATE TABLE error_logs (t_ms INTEGER, status_code INTEGER);
  `);
  const ins = seed.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES (?, ?, 'test', ?, '渠道', 'm', 't1', ?, 0, 10, 10, 0, 0, 5, ?, 1000, 2)`,
  );
  // 逐条 run 会自动提交，Windows 上 fsync 很慢；对拍要插几千行，包一层事务
  seed.exec('BEGIN');
  rows.forEach((row, i) => {
    ins.run(`r${i}`, FROM + i * 1000, row.channelId ?? 1, row.cost ?? 1, row.latency);
  });
  seed.exec('COMMIT');
  seed.close();

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });
  return {
    api,
    close() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function overviewLatency(api) {
  return api.overview(query({})).latency;
}

/** channel_id -> { p50, p95 } */
function channelLatency(api) {
  const { rows } = api.channels(query({}));
  return new Map(rows.map((r) => [r.channel_id, { p50: r.latency_p50, p95: r.latency_p95 }]));
}

test('空集：p50/p95 为 null，count 为 0', () => {
  const { api, close } = makeApi([]);
  try {
    assert.deepEqual(overviewLatency(api), { p50: null, p95: null, count: 0 });
    assert.deepEqual(api.channels(query({})).rows, []);
  } finally {
    close();
  }
});

test('单样本原样返回，不做取整', () => {
  const { api, close } = makeApi([{ channelId: 1, latency: 1234 }]);
  try {
    assert.deepEqual(overviewLatency(api), { p50: 1234, p95: 1234, count: 1 });
    assert.deepEqual(channelLatency(api).get(1), { p50: 1234, p95: 1234 });
  } finally {
    close();
  }
});

test('偶数个样本走线性插值', () => {
  const { api, close } = makeApi([
    { channelId: 1, latency: 100 },
    { channelId: 1, latency: 200 },
  ]);
  try {
    // (2-1)*0.5 = 0.5 → 150；(2-1)*0.95 = 0.95 → 100 + 100*0.95 = 195
    assert.deepEqual(overviewLatency(api), { p50: 150, p95: 195, count: 2 });
  } finally {
    close();
  }
});

test('极端值：0 与超大延迟都按同一插值口径', () => {
  const values = [0, 1, 2, 1_000_000_000];
  const { api, close } = makeApi(values.map((latency) => ({ channelId: 1, latency })));
  try {
    assert.deepEqual(overviewLatency(api), {
      p50: jsPercentile(values, 0.5),
      p95: jsPercentile(values, 0.95),
      count: values.length,
    });
  } finally {
    close();
  }
});

test('latency_ms 为 NULL 的行不计入 count，也不参与分位', () => {
  const { api, close } = makeApi([
    { channelId: 1, latency: 10 },
    { channelId: 1, latency: null },
    { channelId: 1, latency: 30 },
    { channelId: 2, latency: null },
  ]);
  try {
    assert.deepEqual(overviewLatency(api), { p50: 20, p95: 29, count: 2 });
    const channels = channelLatency(api);
    assert.deepEqual(channels.get(1), { p50: 20, p95: 29 });
    // 只有 NULL 延迟的渠道仍是 null，不是 0
    assert.deepEqual(channels.get(2), { p50: null, p95: null });
  } finally {
    close();
  }
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('对拍：与改造前的 JS 实现逐位一致（含渠道分区）', () => {
  const rnd = mulberry32(20261102);
  const styles = [
    (r) => Math.floor(r() * 300000), // 整数毫秒
    (r) => Math.round(r() * 600) * 500, // 真实库里常见的 500 倍数
    (r) => Math.round(r() * 100000) / 100, // 两位数小数
    (r) => [0, 500, 1000, 9000, 53000][Math.floor(r() * 5)], // 大量重复
  ];
  const sizes = [1, 2, 3, 5, 20, 21, 98];

  const rows = [];
  const expected = new Map(); // channel_id -> 该渠道的延迟样本
  styles.forEach((gen, styleIndex) => {
    const base = (styleIndex + 1) * 1000;
    sizes.forEach((size, i) => {
      const channelId = base + i;
      const values = Array.from({ length: size }, () => gen(rnd));
      expected.set(channelId, values);
      for (const latency of values) rows.push({ channelId, latency });
    });
    // 再补一个大分区
    const big = Array.from({ length: 500 }, () => gen(rnd));
    expected.set(base + 99, big);
    for (const latency of big) rows.push({ channelId: base + 99, latency });
  });

  const { api, close } = makeApi(rows);
  try {
    const latencies = rows.map((r) => r.latency);
    assert.deepEqual(
      overviewLatency(api),
      { p50: jsPercentile(latencies, 0.5), p95: jsPercentile(latencies, 0.95), count: latencies.length },
      '整体',
    );
    const channels = channelLatency(api);
    for (const [channelId, values] of expected) {
      assert.deepEqual(
        channels.get(channelId),
        { p50: jsPercentile(values, 0.5), p95: jsPercentile(values, 0.95) },
        `渠道 ${channelId}（n=${values.length}）`,
      );
    }
  } finally {
    close();
  }
});

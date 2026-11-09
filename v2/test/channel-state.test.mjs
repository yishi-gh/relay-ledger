/**
 * 渠道启用状态（channel_state）与 /api/status 分桶改造的单测。
 *
 * 覆盖：整表替换幂等与源库删除渠道后的清理、channels/capital/upstreams/status
 * 按启用状态过滤、缺表回退、15m/1h 分桶与跨日对齐、最少样本与错误率分档、
 * 每桶 top_errors。源库与看板库都建在临时目录，不读生产库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { syncChannelStates } from '../jobs/run-scheduler.mjs';
import {
  readChannelStates,
  readLiveChannelIds,
  replaceChannelStates,
} from '../store/channel-state.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 2026-11-08 23:00 北京时间（UTC 15:00） */
const BASE = Date.UTC(2026, 10, 8, 15, 0, 0);

function params(obj) {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)])),
  );
}

function makeLogs(sourceFile) {
  const db = new DatabaseSync(sourceFile);
  db.exec(`
    CREATE TABLE logs (
      req_id TEXT PRIMARY KEY, t_ms INTEGER NOT NULL, t_local TEXT NOT NULL,
      channel_id INTEGER, channel_name TEXT, model TEXT, token_name TEXT,
      group_name TEXT, cost REAL, quota_raw INTEGER, input_total INTEGER,
      input_uncached INTEGER, cache_read INTEGER, cache_write INTEGER,
      output INTEGER, latency_ms INTEGER, first_token_ms INTEGER, log_type INTEGER
    );
    CREATE TABLE error_logs (t_ms INTEGER, status_code INTEGER);
  `);
  let seq = 0;
  const insert = db.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name,
                       group_name, cost, quota_raw, input_total, input_uncached, cache_read,
                       cache_write, output, latency_ms, first_token_ms, log_type)
     VALUES (?, ?, 'test', ?, ?, 'm', 't1', ?, 0, 0, 10, 10, 0, 0, 5, 1000, 1000, 2)`,
  );
  return {
    db,
    addLog({
      tMs,
      channelId = 13,
      channelName = '渠道一',
      groupName = 'default',
      count = 1,
    }) {
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        insert.run(`r${seq}`, tMs, channelId, channelName, groupName);
      }
    },
    close() {
      db.close();
    },
  };
}

const ACCOUNTS = [
  {
    id: 'acc-live',
    name: 'Live',
    kind: 'newapi',
    base_url: 'https://a.test',
    unit: 'USD',
    enabled: true,
    channels: [13],
  },
  {
    id: 'acc-dead',
    name: 'Dead',
    kind: 'newapi',
    base_url: 'https://b.test',
    unit: 'USD',
    enabled: true,
    channels: [14, 15],
  },
  {
    id: 'acc-mixed',
    name: 'Mixed',
    kind: 'newapi',
    base_url: 'https://c.test',
    unit: 'USD',
    enabled: true,
    channels: [13, 27, 14],
  },
];

function setup({
  logs = [],
  errors = [],
  channelStates = null,
  dropChannelState = false,
} = {}) {
  const dir = makeTempDir('v2-channel-state-');
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const logsDb = makeLogs(sourceFile);
  for (const row of logs) logsDb.addLog(row);
  logsDb.close();

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  if (channelStates) replaceChannelStates(dashboard, channelStates);

  const insertError = dashboard.prepare(
    `INSERT INTO upstream_error
       (id, t_ms, channel_id, channel_name, model, group_name, status_code, message, request_id, recorded_at)
     VALUES (?, ?, ?, ?, 'm', ?, ?, 'boom', NULL, 0)`,
  );
  let errorId = 0;
  for (const row of errors) {
    errorId += 1;
    insertError.run(
      row.id ?? errorId,
      row.tMs,
      row.channelId ?? 13,
      row.channelName ?? '渠道一',
      row.groupName ?? 'default',
      row.status ?? 500,
    );
  }

  // 模拟旧库：建表后再删掉 channel_state，接口应按「表不存在」回退
  if (dropChannelState) dashboard.exec('DROP TABLE channel_state');

  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: ACCOUNTS },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });

  return {
    api,
    dashboard,
    dir,
    close() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// channel_state 存取与同步
// ---------------------------------------------------------------------------

test('channel_state：整表替换幂等，源库删除的渠道再同步后消失', () => {
  const dir = makeTempDir('v2-channel-state-store-');
  const dashboardFile = path.join(dir, 'dashboard.db');
  const relayFile = path.join(dir, 'one-api.db');
  const db = openDashboardDb(dashboardFile);
  const relay = new DatabaseSync(relayFile);
  relay.exec(
    'CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, status INTEGER, base_url TEXT)',
  );
  const ins = relay.prepare(
    'INSERT INTO channels (id, name, status, base_url) VALUES (?, ?, ?, ?)',
  );
  ins.run(13, '渠道一', 1, 'https://a.test');
  ins.run(27, '渠道二', 2, 'https://b.test');
  relay.close();

  try {
    assert.equal(syncChannelStates(db, relayFile), 2);
    const states = readChannelStates(db);
    assert.equal(states.size, 2);
    assert.deepEqual(states.get(13), { status: 1, name: '渠道一' });
    assert.deepEqual(states.get(27), { status: 2, name: '渠道二' });
    assert.deepEqual([...readLiveChannelIds(db)], [13]);
    assert.equal(
      typeof db.prepare('SELECT MIN(updated_at) AS t FROM channel_state').get().t,
      'number',
    );

    // 幂等：同一源库连续同步，行数与内容不变
    assert.equal(syncChannelStates(db, relayFile), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel_state').get().n, 2);

    // 源库删掉一个渠道：整表替换后表里不再有它
    const relayAgain = new DatabaseSync(relayFile);
    relayAgain.prepare('DELETE FROM channels WHERE id = 27').run();
    relayAgain.close();
    assert.equal(syncChannelStates(db, relayFile), 1);
    assert.equal(readChannelStates(db).has(27), false);
    assert.deepEqual([...readLiveChannelIds(db)], [13]);

    // 源库一个渠道都没有：表清空，读取返回 null（接口回退）
    replaceChannelStates(db, []);
    assert.equal(readChannelStates(db), null);
    assert.equal(readLiveChannelIds(db), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 按渠道状态过滤
// ---------------------------------------------------------------------------

test('channels：只返回启用渠道，停用与已删除渠道不出现', () => {
  const fx = setup({
    logs: [
      { tMs: BASE + 5 * MINUTE, channelId: 13, channelName: '渠道一' },
      { tMs: BASE + 6 * MINUTE, channelId: 27, channelName: '渠道二' },
      { tMs: BASE + 7 * MINUTE, channelId: 99, channelName: '已删除' },
    ],
    channelStates: [
      { id: 13, name: '渠道一', status: 1, base_url: 'https://a.test' },
      { id: 27, name: '渠道二', status: 2, base_url: 'https://b.test' },
    ],
  });
  try {
    const { rows } = fx.api.channels(params({ from: BASE, to: BASE + HOUR - 1 }));
    assert.deepEqual(rows.map((r) => r.channel_id), [13]);
    assert.equal(rows[0].channel_status, 1);
    assert.equal(rows[0].channel_name, '渠道一');
  } finally {
    fx.close();
  }
});

test('capital：0 live 的账户被排除，混合账户带 total/live 计数', () => {
  const fx = setup({
    channelStates: [
      { id: 13, name: '渠道一', status: 1, base_url: 'https://a.test' },
      { id: 27, name: '渠道二', status: 1, base_url: 'https://b.test' },
    ],
  });
  try {
    const data = fx.api.capital(params({ from: BASE - HOUR, to: BASE }));
    assert.deepEqual(data.accounts.map((a) => a.account_id), ['acc-live', 'acc-mixed']);

    const mixed = data.accounts.find((a) => a.account_id === 'acc-mixed');
    assert.equal(mixed.channels_total, 3); // 13 / 27 / 14（14 已从源库删除）
    assert.equal(mixed.channels_live, 2); // 13、27 启用，被删除的 14 不算
    assert.equal(mixed.channels_total - mixed.channels_live, 1);

    const live = data.accounts.find((a) => a.account_id === 'acc-live');
    assert.equal(live.channels_total, 1);
    assert.equal(live.channels_live, 1);

    // 0 live 的账户不进 accounts，也不进 total
    assert.equal(data.accounts.some((a) => a.account_id === 'acc-dead'), false);
    assert.deepEqual(data.accounts.map((a) => a.account_id).sort(), ['acc-live', 'acc-mixed']);
  } finally {
    fx.close();
  }
});

test('upstreams：0 live 的账户保留，只补 channels_total/channels_live', () => {
  const fx = setup({
    channelStates: [
      { id: 13, name: '渠道一', status: 1, base_url: 'https://a.test' },
      { id: 27, name: '渠道二', status: 1, base_url: 'https://b.test' },
    ],
  });
  try {
    const { accounts } = fx.api.upstreams(params({ from: BASE - HOUR, to: BASE }));
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    assert.equal(byId['acc-dead'].channels_total, 2);
    assert.equal(byId['acc-dead'].channels_live, 0);
    assert.equal(byId['acc-mixed'].channels_total, 3);
    assert.equal(byId['acc-mixed'].channels_live, 2);
  } finally {
    fx.close();
  }
});

test('status：渠道与分组都按启用状态过滤', () => {
  const fx = setup({
    logs: [
      { tMs: BASE + 5 * MINUTE, channelId: 13, channelName: '渠道一', groupName: 'default', count: 3 },
      { tMs: BASE + 6 * MINUTE, channelId: 27, channelName: '渠道二', groupName: 'vip', count: 3 },
    ],
    errors: [
      { tMs: BASE + 10 * MINUTE, channelId: 99, channelName: '已删除', groupName: 'ghost' },
    ],
    channelStates: [
      { id: 13, name: '渠道一', status: 1, base_url: 'https://a.test' },
      { id: 27, name: '渠道二', status: 2, base_url: 'https://b.test' },
    ],
  });
  try {
    const byChannel = fx.api.status(
      params({ from: BASE, to: BASE + HOUR - 1, level: 'channel', bucket: '1h' }),
    );
    assert.deepEqual(byChannel.components.map((c) => c.key), ['13']);

    // 分组：vip 只有停用渠道 27，ghost 只有已删除渠道 99，default 含启用渠道 13
    const byGroup = fx.api.status(
      params({ from: BASE, to: BASE + HOUR - 1, level: 'group', bucket: '1h' }),
    );
    assert.deepEqual(byGroup.components.map((c) => c.key), ['default']);
    assert.equal(byGroup.overall.requests, 3);
    assert.equal(byGroup.overall.errors, 0);
  } finally {
    fx.close();
  }
});

test('回退：channel_state 缺表时四个接口行为与改动前一致', () => {
  const fx = setup({
    logs: [
      { tMs: BASE + 5 * MINUTE, channelId: 13 },
      { tMs: BASE + 6 * MINUTE, channelId: 27, channelName: '渠道二' },
      { tMs: BASE + 7 * MINUTE, channelId: 99, channelName: '已删除' },
    ],
    dropChannelState: true,
  });
  try {
    const { rows } = fx.api.channels(params({ from: BASE, to: BASE + HOUR - 1 }));
    assert.deepEqual(rows.map((r) => r.channel_id).sort((a, b) => a - b), [13, 27, 99]);
    assert.equal('channel_status' in rows[0], false);

    const capital = fx.api.capital(params({ from: BASE - HOUR, to: BASE }));
    assert.deepEqual(
      capital.accounts.map((a) => a.account_id),
      ['acc-live', 'acc-dead', 'acc-mixed'],
    );
    assert.equal('channels_total' in capital.accounts[0], false);

    const { accounts } = fx.api.upstreams(params({ from: BASE - HOUR, to: BASE }));
    assert.equal(accounts.length, 3);
    assert.equal('channels_live' in accounts[0], false);

    const status = fx.api.status(
      params({ from: BASE, to: BASE + HOUR - 1, bucket: '1h' }),
    );
    assert.deepEqual(status.components.map((c) => c.key).sort(), ['13', '27', '99']);
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// status 分桶 / 状态判定
// ---------------------------------------------------------------------------

test('status：bucket=15m/1h 的桶数与跨日对齐，缺省按区间跨度选择', () => {
  const fx = setup({
    logs: [
      { tMs: BASE + 5 * MINUTE },
      { tMs: BASE + 50 * MINUTE },
    ],
  });
  try {
    const day15 = fx.api.status(params({ from: BASE, to: BASE + 24 * HOUR, bucket: '15m' }));
    assert.equal(day15.bucket, '15m');
    assert.equal(day15.components[0].buckets.length, 96);

    const day1h = fx.api.status(params({ from: BASE, to: BASE + 24 * HOUR, bucket: '1h' }));
    assert.equal(day1h.bucket, '1h');
    assert.equal(day1h.components[0].buckets.length, 24);

    // 缺省：24h ≤ 36h → 15m；48h → 1h
    const auto = fx.api.status(params({ from: BASE, to: BASE + 24 * HOUR }));
    assert.equal(auto.bucket, '15m');
    assert.equal(auto.components[0].buckets.length, 96);
    const long = fx.api.status(params({ from: BASE, to: BASE + 48 * HOUR }));
    assert.equal(long.bucket, '1h');
    assert.equal(long.components[0].buckets.length, 48);

    // 跨日：23:45 起按 15 分钟整刻对齐，日界不产生偏移
    const cross = fx.api.status(
      params({ from: BASE + 45 * MINUTE, to: BASE + HOUR + 20 * MINUTE, bucket: '15m' }),
    );
    assert.deepEqual(
      cross.components[0].buckets.map((b) => [b.t_ms, b.label, b.total]),
      [
        [BASE + 45 * MINUTE, '2026-11-08 23:45', 1], // 23:50 的日志落在 23:45 桶
        [BASE + HOUR, '2026-11-09 00:00', 0],
        [BASE + HOUR + 15 * MINUTE, '2026-11-09 00:15', 0],
      ],
    );

    assert.throws(
      () => fx.api.status(params({ from: BASE, to: BASE + HOUR, bucket: '6h' })),
      /bucket 只能是 15m 或 1h/,
    );
  } finally {
    fx.close();
  }
});

test('status：最少样本、错误率分档与每桶 top_errors', () => {
  const logs = [
    { tMs: BASE + HOUR + 5 * MINUTE, count: 100 }, // 1 错 / 100 尝试 → warn
    { tMs: BASE + 2 * HOUR + 5 * MINUTE, count: 100 }, // 3 错 / 103 尝试 → fail
    { tMs: BASE + 3 * HOUR + 5 * MINUTE, count: 100 }, // top_errors 桶
    { tMs: BASE + 4 * HOUR + 5 * MINUTE, count: 2 }, // 3 次尝试 1 错 → 33% fail
  ];
  const errors = [
    { tMs: BASE + 5 * MINUTE, status: 500 }, // 该桶仅 1 次尝试 → unknown
    { tMs: BASE + HOUR + 10 * MINUTE, status: 500 },
    { tMs: BASE + 2 * HOUR + 10 * MINUTE, status: 502 },
    { tMs: BASE + 2 * HOUR + 11 * MINUTE, status: 502 },
    { tMs: BASE + 2 * HOUR + 12 * MINUTE, status: 502 },
    { tMs: BASE + 3 * HOUR + 10 * MINUTE, status: 502 },
    { tMs: BASE + 3 * HOUR + 11 * MINUTE, status: 502 },
    { tMs: BASE + 3 * HOUR + 12 * MINUTE, status: 502 },
    { tMs: BASE + 3 * HOUR + 13 * MINUTE, status: 500 },
    { tMs: BASE + 3 * HOUR + 14 * MINUTE, status: 500 },
    { tMs: BASE + 3 * HOUR + 15 * MINUTE, status: 429 },
    { tMs: BASE + 3 * HOUR + 16 * MINUTE, status: 503 },
    { tMs: BASE + 3 * HOUR + 17 * MINUTE, status: 504 },
    { tMs: BASE + 3 * HOUR + 18 * MINUTE, status: 418 },
    { tMs: BASE + 4 * HOUR + 10 * MINUTE, status: 500 },
  ];
  const fx = setup({ logs, errors });
  try {
    const payload = fx.api.status(
      params({ from: BASE, to: BASE + 5 * HOUR + 30 * MINUTE, bucket: '1h', level: 'channel' }),
    );
    const [channel] = payload.components;
    const states = channel.buckets.map((b) => [b.total, b.errors, b.state]);
    assert.deepEqual(states, [
      [0, 1, 'unknown'], // 1 次尝试：样本不足，不判 fail
      [100, 1, 'warn'], // 1/101 < 2%
      [100, 3, 'fail'], // 3/103 ≥ 2%
      [100, 9, 'fail'],
      // 2 成功 + 1 错误 = 3 次尝试，错误率 1/3 ≥ 2% → fail（最少样本只管 <3 次）
      [2, 1, 'fail'],
      [0, 0, 'none'], // 空桶
    ]);

    // 每桶 top_errors：按次数降序、次数相同按状态码升序、最多 5 条
    assert.deepEqual(channel.buckets[3].top_errors, [
      { status: 502, count: 3 },
      { status: 500, count: 2 },
      { status: 418, count: 1 },
      { status: 429, count: 1 },
      { status: 503, count: 1 },
    ]);
    assert.equal(channel.buckets[3].top_errors.length, 5);
    assert.equal(channel.buckets[3].top_errors.some((e) => e.status === 504), false);
    assert.deepEqual(channel.buckets[0].top_errors, [{ status: 500, count: 1 }]);
    assert.deepEqual(channel.buckets[5].top_errors, []);

    // 组件级 uptime 与 overall 口径不变
    assert.equal(channel.uptime, 0.952681);
    assert.deepEqual(payload.overall, {
      requests: 302,
      errors: 15,
      uptime: 0.952681,
    });
  } finally {
    fx.close();
  }
});

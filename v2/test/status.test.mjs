/**
 * 渠道/分组健康（/api/status）与上游错误同步（collect-upstream-errors）单测。
 *
 * 覆盖：北京整点分桶跨自然日、渠道/分组两种聚合、uptime 分母 0 → null、
 * state 三档、空桶 none、coverage.errors_since，以及采集器的幂等、水位、dry-run。
 * 源库与看板库都建在临时目录，不读生产库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import {
  BATCH_SIZE,
  MESSAGE_MAX,
  OFFSET_KEY,
  main as collectMain,
  parseArgs as parseCollectArgs,
  parseStatusCode,
  parseUpstreamErrorRow,
  readWatermark,
  runCollectUpstreamErrors,
} from '../jobs/collect-upstream-errors.mjs';
import {
  DEFAULT_UPSTREAM_ERRORS_INTERVAL_MS,
  TASK_UPSTREAM_ERRORS,
  UPSTREAM_ERRORS_INITIAL_DELAY_MS,
  splitUpstreamErrorsArgs,
} from '../jobs/run-scheduler.mjs';
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

function setup({ logs = [], errors = [] } = {}) {
  const dir = makeTempDir('v2-status-');
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const logsDb = makeLogs(sourceFile);
  for (const row of logs) logsDb.addLog(row);
  logsDb.close();

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
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

  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
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
// /api/status
// ---------------------------------------------------------------------------

test('status：北京整点分桶跨自然日，空桶 state=none', () => {
  const fx = setup({
    logs: [
      { tMs: BASE + 30 * MINUTE },
      { tMs: BASE + HOUR + 30 * MINUTE },
    ],
  });
  try {
    const payload = fx.api.status(params({
      from: BASE + 30 * MINUTE,
      to: BASE + HOUR + 30 * MINUTE,
      bucket: '1h',
    }));
    assert.equal(payload.level, 'channel');
    assert.equal(payload.components.length, 1);

    const [channel] = payload.components;
    assert.equal(channel.key, '13');
    assert.equal(channel.name, '渠道一');
    assert.equal(channel.requests, 2);
    assert.equal(channel.errors, 0);
    assert.equal(channel.uptime, 1);
    assert.deepEqual(
      channel.buckets.map((b) => [b.t_ms, b.label, b.total, b.state]),
      [
        // 每桶只有 1 次成功：样本 < 3 判 unknown，不再直接给 ok
        [BASE, '2026-11-08 23:00', 1, 'unknown'],
        [BASE + HOUR, '2026-11-09 00:00', 1, 'unknown'],
      ],
    );
  } finally {
    fx.close();
  }
});

test('status：渠道聚合的 uptime、state 三档与 Top 错误码', () => {
  const logs = [
    { tMs: BASE + 5 * MINUTE, channelId: 13, channelName: '渠道一', count: 100 },
    { tMs: BASE + 6 * MINUTE, channelId: 27, channelName: '渠道二', groupName: 'vip', count: 10 },
    { tMs: BASE + HOUR + 5 * MINUTE, channelId: 13, channelName: '渠道一', count: 100 },
  ];
  const errors = [
    { tMs: BASE + 10 * MINUTE, channelId: 13, channelName: '渠道一', status: 500 },
    { tMs: BASE + 11 * MINUTE, channelId: 13, channelName: '渠道一', status: 500 },
    { tMs: BASE + 12 * MINUTE, channelId: 13, channelName: '渠道一', status: 502 },
    { tMs: BASE + HOUR + 10 * MINUTE, channelId: 13, channelName: '渠道一', status: 503 },
  ];
  const fx = setup({ logs, errors });
  try {
    const payload = fx.api.status(
      params({ from: BASE, to: BASE + 2 * HOUR + 30 * MINUTE, level: 'channel', bucket: '1h' }),
    );
    assert.equal(payload.level, 'channel');
    assert.equal(payload.components.length, 2);

    const [first, second] = payload.components;
    assert.equal(first.key, '13');
    assert.equal(first.requests, 200);
    assert.equal(first.errors, 4);
    // 200 / (200 + 4)：分母是尝试总数，不是成功数
    assert.equal(first.uptime, 0.980392);
    assert.deepEqual(
      first.buckets.map((b) => [b.t_ms, b.total, b.errors, b.state]),
      [
        [BASE, 100, 3, 'fail'], // 3/100 = 0.03 ≥ 0.02
        [BASE + HOUR, 100, 1, 'warn'], // 1/100 = 0.01
        [BASE + 2 * HOUR, 0, 0, 'none'], // 该小时无请求
      ],
    );
    assert.deepEqual(first.top_errors, [
      { status: 500, count: 2 },
      { status: 502, count: 1 },
      { status: 503, count: 1 },
    ]);

    assert.equal(second.key, '27');
    assert.equal(second.errors, 0);
    assert.equal(second.uptime, 1);
    assert.equal(second.buckets[0].state, 'ok');

    assert.deepEqual(payload.overall, {
      requests: 210,
      errors: 4,
      uptime: 0.981308,
    });
  } finally {
    fx.close();
  }
});

test('status：分组聚合按 group_name，错误独有的分组保留且 uptime=null', () => {
  const logs = [
    { tMs: BASE + 5 * MINUTE, channelId: 13, channelName: '渠道一', groupName: 'default', count: 4 },
    { tMs: BASE + 6 * MINUTE, channelId: 27, channelName: '渠道二', groupName: 'vip', count: 2 },
    { tMs: BASE + 7 * MINUTE, channelId: 31, channelName: '渠道三', groupName: null, count: 1 },
  ];
  const errors = [
    { tMs: BASE + 10 * MINUTE, channelId: 13, channelName: '渠道一', groupName: 'default', status: 500 },
    { tMs: BASE + 11 * MINUTE, channelId: 27, channelName: '渠道二', groupName: 'vip', status: 429 },
    { tMs: BASE + 12 * MINUTE, channelId: 99, channelName: '已下线渠道', groupName: 'ghost', status: 502 },
    { tMs: BASE + 13 * MINUTE, channelId: 99, channelName: '已下线渠道', groupName: 'ghost', status: 502 },
  ];
  const fx = setup({ logs, errors });
  try {
    const payload = fx.api.status(
      params({ from: BASE, to: BASE + HOUR - 1, level: 'group', bucket: '1h' }),
    );
    assert.equal(payload.level, 'group');
    // 错误多的分组排前面
    assert.deepEqual(payload.components.map((c) => c.key), ['ghost', 'default', 'vip', '']);

    const byKey = new Map(payload.components.map((c) => [c.key, c]));
    assert.equal(byKey.get('default').requests, 4);
    assert.equal(byKey.get('default').errors, 1);
    // 5 次尝试（4 成功 + 1 错），成功算 4/5；旧口径 (4-1)/4 会把错误从成功里扣一遍
    assert.equal(byKey.get('default').uptime, 0.8);
    assert.equal(byKey.get('default').top_errors[0].status, 500);

    assert.equal(byKey.get('vip').uptime, 0.666667);
    assert.equal(byKey.get('').name, '未分组');
    assert.equal(byKey.get('').uptime, 1);

    const ghost = byKey.get('ghost');
    assert.equal(ghost.name, 'ghost');
    assert.equal(ghost.requests, 0);
    assert.equal(ghost.errors, 2);
    // 只有错误、没有成功：可用率就是 0，不能返回 null 掩盖
    // 该小时只有 2 次尝试（2 错误），样本 < 3 判 unknown；'none' 只给真正没有尝试的桶
    assert.equal(ghost.buckets[0].state, 'unknown');

    assert.deepEqual(payload.overall, {
      requests: 7,
      errors: 4,
      uptime: 0.636364,
    });
  } finally {
    fx.close();
  }
});

test('status：coverage.errors_since 取全表最早一条；空库为 null', () => {
  const fx = setup({
    logs: [{ tMs: BASE + 5 * MINUTE }],
    errors: [
      { tMs: BASE - 3 * 24 * HOUR, status: 500 },
      { tMs: BASE + 10 * MINUTE, status: 502 },
    ],
  });
  try {
    const payload = fx.api.status(params({ from: BASE, to: BASE + HOUR - 1 }));
    assert.equal(payload.coverage.errors_since, BASE - 3 * 24 * HOUR);
  } finally {
    fx.close();
  }

  const empty = setup();
  try {
    const payload = empty.api.status(params({ from: BASE, to: BASE + HOUR - 1 }));
    assert.deepEqual(payload.components, []);
    assert.deepEqual(payload.overall, { requests: 0, errors: 0, uptime: null });
    assert.deepEqual(payload.coverage, { errors_since: null });
  } finally {
    empty.close();
  }
});

test('status：level 只接受 channel / group', () => {
  const fx = setup();
  try {
    assert.throws(
      () => fx.api.status(params({ from: BASE, to: BASE + HOUR - 1, level: 'model' })),
      /level 只能是 channel 或 group/,
    );
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// collect-upstream-errors
// ---------------------------------------------------------------------------

function makeRelayDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type INTEGER,
      created_at INTEGER,
      channel_id INTEGER,
      channel_name TEXT,
      model_name TEXT,
      "group" TEXT,
      content TEXT,
      request_id TEXT
    );
  `);
  return db;
}

function addRelayRow(db, {
  type = 5,
  createdAt = Math.floor(BASE / 1000),
  channelId = 13,
  channelName = '渠道一',
  model = 'gpt-4o',
  group = 'default',
  content = 'status_code=500, upstream error: do request failed',
  requestId = 'req-1',
} = {}) {
  db.prepare(
    `INSERT INTO logs (type, created_at, channel_id, channel_name, model_name, "group", content, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(type, createdAt, channelId, channelName, model, group, content, requestId);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

test('collect：只同步 type=5，秒转毫秒、状态码提取、原文截断', () => {
  const dir = makeTempDir('v2-upstream-errors-');
  const relayFile = path.join(dir, 'one-api.db');
  const dashboardFile = path.join(dir, 'dashboard.db');
  const relay = makeRelayDb(relayFile);
  addRelayRow(relay, { type: 2, content: 'status_code=200' });
  addRelayRow(relay, { content: 'status_code=502, upstream error: bad gateway', requestId: 'r-502' });
  addRelayRow(relay, { content: 'no status code here', requestId: 'r-null' });
  addRelayRow(relay, { content: 'x'.repeat(900), requestId: 'r-long' });
  relay.close();

  const db = openDashboardDb(dashboardFile);
  try {
    const summary = runCollectUpstreamErrors({
      relayDbFile: relayFile,
      dbFile: dashboardFile,
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(summary.missing, false);
    assert.equal(summary.scanned, 3);
    assert.equal(summary.inserted, 3);

    const rows = db.prepare('SELECT * FROM upstream_error ORDER BY id').all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].t_ms, BASE);
    assert.equal(rows[0].status_code, 502);
    assert.equal(rows[0].request_id, 'r-502');
    assert.equal(rows[0].channel_name, '渠道一');
    assert.equal(rows[0].group_name, 'default');
    assert.equal(rows[0].model, 'gpt-4o');
    assert.equal(rows[1].status_code, null);
    assert.equal(rows[2].message.length, MESSAGE_MAX);
    assert.equal(readWatermark(db), rows[2].id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect：按 logs.id 幂等，水位只前移不重读', () => {
  const dir = makeTempDir('v2-upstream-errors-');
  const relayFile = path.join(dir, 'one-api.db');
  const dashboardFile = path.join(dir, 'dashboard.db');
  const relay = makeRelayDb(relayFile);
  const firstId = addRelayRow(relay, { requestId: 'r-1' });
  relay.close();

  const db = openDashboardDb(dashboardFile);
  try {
    const first = runCollectUpstreamErrors({
      relayDbFile: relayFile,
      dbFile: dashboardFile,
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(first.inserted, 1);
    assert.equal(readWatermark(db), firstId);

    // 再跑一轮：没有新行，不重复插入
    const second = runCollectUpstreamErrors({
      relayDbFile: relayFile,
      dbFile: dashboardFile,
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(second.scanned, 0);
    assert.equal(second.inserted, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upstream_error').get().n, 1);

    // 源库新增一行：只读新增部分
    const appender = makeRelayDb(relayFile);
    const newId = addRelayRow(appender, { requestId: 'r-2', content: 'status_code=503' });
    appender.close();
    const third = runCollectUpstreamErrors({
      relayDbFile: relayFile,
      dbFile: dashboardFile,
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(third.scanned, 1);
    assert.equal(third.inserted, 1);
    assert.equal(readWatermark(db), newId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upstream_error').get().n, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect：dry-run 不写库、不写水位，库文件不存在也不创建', () => {
  const dir = makeTempDir('v2-upstream-errors-');
  const relayFile = path.join(dir, 'one-api.db');
  const dashboardFile = path.join(dir, 'dashboard.db');
  const relay = makeRelayDb(relayFile);
  addRelayRow(relay);
  addRelayRow(relay);
  relay.close();

  const summary = runCollectUpstreamErrors({
    relayDbFile: relayFile,
    dbFile: dashboardFile,
    dryRun: true,
    log: () => {},
    errorLog: () => {},
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.inserted, 2);
  assert.equal(fs.existsSync(dashboardFile), false);

  const db = openDashboardDb(dashboardFile);
  try {
    assert.equal(readWatermark(db), 0);
    runCollectUpstreamErrors({
      relayDbFile: relayFile,
      dbFile: dashboardFile,
      dryRun: true,
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upstream_error').get().n, 0);
    assert.equal(readWatermark(db), 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect：源库不存在打一行提示，退出码 0', () => {
  const dir = makeTempDir('v2-upstream-errors-');
  const missing = path.join(dir, 'nope.db');
  const dbFile = path.join(dir, 'dashboard.db');
  const lines = [];
  const code = collectMain([`--relay-db=${missing}`, `--db=${dbFile}`], {
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /warn.*源库不存在/);
  assert.equal(fs.existsSync(dbFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collect：参数解析与纯函数（状态码、时间无法解析时跳过）', () => {
  const dir = makeTempDir('v2-upstream-errors-');
  const relayFile = path.join(dir, 'one-api.db');
  const dbFile = path.join(dir, 'dashboard.db');

  assert.deepEqual(parseCollectArgs(['--relay-db', relayFile, '--db', dbFile, '--dry-run']), {
    help: false,
    relayDbFile: relayFile,
    dbFile,
    dryRun: true,
  });
  assert.deepEqual(parseCollectArgs([`--relay-db=${relayFile}`]).relayDbFile, relayFile);
  assert.throws(() => parseCollectArgs(['--relay-db']), /--relay-db 不能为空/);

  assert.equal(parseStatusCode('status_code=429, upstream error'), 429);
  assert.equal(parseStatusCode('nothing'), null);
  assert.equal(parseStatusCode(null), null);

  const parsed = parseUpstreamErrorRow({
    id: 7,
    created_at: 1_700_000_000,
    channel_id: 13,
    channel_name: '渠道一',
    model_name: 'gpt-4o',
    group_name: 'default',
    content: 'status_code=500',
    request_id: 'r',
  }, 123);
  assert.equal(parsed.t_ms, 1_700_000_000_000);
  assert.equal(parsed.recorded_at, 123);
  assert.equal(parseUpstreamErrorRow({ id: 8, created_at: 'bad' }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('调度：upstream-errors 任务名、间隔与 --no-upstream-errors', () => {
  assert.equal(TASK_UPSTREAM_ERRORS, 'upstream-errors');
  assert.equal(UPSTREAM_ERRORS_INITIAL_DELAY_MS, 7 * 60 * 1000);
  assert.equal(DEFAULT_UPSTREAM_ERRORS_INTERVAL_MS, 15 * 60 * 1000);
  assert.equal(BATCH_SIZE, 2000);
  assert.equal(OFFSET_KEY, 'upstream_error_offset');
  assert.deepEqual(splitUpstreamErrorsArgs(['--no-upstream-errors', '--once']), {
    upstreamErrors: { enabled: false },
    rest: ['--once'],
  });
  assert.deepEqual(splitUpstreamErrorsArgs(['--once']), {
    upstreamErrors: { enabled: true },
    rest: ['--once'],
  });
});

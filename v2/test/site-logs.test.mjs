/**
 * collect-site-logs 单测：NDJSON 解析、字段归一、增量窗口、幂等、dry-run、失败不写库、
 * 报告脱敏、导出端点缺失时的分页回退。全部临时 sqlite + 注入 fetch，不访问网络。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { DAY_MS } from '../lib/time.mjs';
import { countLogs, insertLogs, LOGS_SCHEMA, openLogsDb, readLastLogTime } from '../store/site-logs.mjs';
import {
  DEFAULT_DB_FILE,
  normalizeLogItem,
  parseArgs,
  parseExportNdjson,
  parseSinceArg,
  pickToken,
  resolveSinceMs,
  runCollectSiteLogs,
  SITE,
} from '../jobs/collect-site-logs.mjs';
import { INSTANCE } from '../lib/instance.mjs';
import { createMockFetch, jsonResponse, makeTempDir } from './helpers/fixture.mjs';

const PAT = 'sk-test-pat-abcdef123456';
const NOW = Date.UTC(2026, 9, 22, 4, 0, 0); // 2026-10-22 12:00 北京时间
const T0 = NOW - 3600_000;

/** 临时站点库：按现有 37 列表结构建表，可预置行 */
function makeDb(rows = []) {
  const dir = makeTempDir('v2-site-logs-');
  const file = path.join(dir, 'relay.db');
  const raw = new DatabaseSync(file);
  raw.exec(LOGS_SCHEMA);
  raw.close();
  const db = openLogsDb(file);
  if (rows.length > 0) insertLogs(db, rows);
  return {
    file,
    db,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('打开站点库时补齐聚合覆盖索引，看板聚合走 index-only scan', () => {
  const t = makeDb();
  try {
    const names = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_logs_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(names.includes('idx_logs_agg'), `缺少 idx_logs_agg：${names.join(',')}`);
    assert.ok(names.includes('idx_logs_overview'), `缺少 idx_logs_overview：${names.join(',')}`);

    const ro = openLogsDb(t.file, { readOnly: true });
    try {
      const plan = ro
        .prepare("EXPLAIN QUERY PLAN SELECT SUM(cost) FROM logs WHERE log_type = 2 AND t_ms BETWEEN 0 AND 1")
        .all();
      assert.match(JSON.stringify(plan), /COVERING INDEX/);
    } finally {
      ro.close();
    }
  } finally {
    t.cleanup();
  }
});

function makeItem(overrides = {}) {
  return {
    id: 1001,
    type: 2,
    created_at: Math.floor(T0 / 1000),
    prompt_tokens: 1000,
    completion_tokens: 120,
    cache_tokens: 200,
    quota: 2500,
    channel: 13,
    channel_name: '渠道一',
    group: 'default',
    token_name: 'tk-test',
    model_name: 'gpt-x',
    use_time: 1.5,
    is_stream: true,
    ip: '203.0.113.9',
    content: 'hi',
    other: '{}',
    ...overrides,
  };
}

function ndjson(items, result = { success: true, data: { count: items.length }, message: '' }) {
  return `${items.map((i) => JSON.stringify(i)).join('\n')}\n${JSON.stringify(result)}\n`;
}

function exportHandler(text, status = 200) {
  return createMockFetch((u) => {
    if (u.pathname === '/api/log/export') return new Response(text, { status });
    throw new Error(`未预期的请求 ${u.pathname}`);
  });
}

function run(db, fetchImpl, extra = {}) {
  // 兼容用例默认单请求；分片用例显式传 chunkDays。直读用例显式传 source=db
  return runCollectSiteLogs({
    db,
    pat: PAT,
    source: 'http',
    baseUrl: 'https://relay.test',
    nowMs: NOW,
    fetchImpl,
    minIntervalMs: 0,
    chunkDays: 0,
    ...extra,
  });
}

test('pickToken：单行纯 token，或多行「名称：token」取站点 id 那行', () => {
  // 单行文件就是一个 PAT，不带名称
  assert.equal(pickToken('sk-single-line-token\n', 'relay'), 'sk-single-line-token');
  // 多行：优先名称等于 hint 的行
  const text = ['tmtoken：other-value', 'relay：sk-real', '备注：x'].join('\n');
  assert.equal(pickToken(text, 'relay'), 'sk-real');
  // 没有同名行时退回第一行
  assert.equal(pickToken('tmtoken：other-value\n备注：x', 'relay'), 'other-value');
  assert.equal(pickToken('', 'relay'), null);
});

test('NDJSON 解析：日志行保留，末行结果对象单独返回，坏行计数', () => {
  const items = [makeItem(), makeItem({ id: 1002, created_at: Math.floor(T0 / 1000) + 60 })];
  const parsed = parseExportNdjson(`${ndjson(items)}not-json\n`);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.badLines, 1);
  assert.equal(parsed.result.success, true);
  assert.equal(parsed.result.data.count, 2);
});

test('字段归一：37 列口径与 v1 一致，非消耗日志返回 null', () => {
  const row = normalizeLogItem(makeItem(), { now: NOW });
  assert.equal(row.site, SITE);
  assert.equal(row.source_kind, 'newapi');
  assert.equal(row.input_format, 'api_ndjson');
  assert.equal(row.t_ms, T0);
  assert.equal(row.channel_id, 13);
  assert.equal(row.channel_name, '渠道一');
  assert.equal(row.group_name, 'default');
  assert.equal(row.log_type, 2);
  assert.equal(row.quota_raw, 2500);
  assert.equal(row.cost, 0.005); // 2500 / 500000
  assert.equal(row.input_total, 1000);
  assert.equal(row.input_uncached, 800);
  assert.equal(row.cache_read, 200);
  assert.equal(row.token_semantic, 'includes_cache');
  assert.equal(row.rate_multiplier, null);
  assert.equal(row.req_id, '1001');
  assert.equal(row.ck.length, 40);
  assert.equal(normalizeLogItem(makeItem({ type: 1 })), null);
  assert.equal(normalizeLogItem(makeItem({ created_at: '' })), null);
});

test('同一批数据导入两次：第二次插入 0，重复全部跳过', async () => {
  const { db, cleanup } = makeDb();
  try {
    const items = [makeItem(), makeItem({ id: 1002, created_at: Math.floor(T0 / 1000) + 60 })];
    const { fetchImpl } = exportHandler(ndjson(items));

    const first = await run(db, fetchImpl);
    assert.equal(first.transport, 'export');
    assert.equal(first.pages, 1);
    assert.equal(first.rows, 2);
    assert.equal(first.inserted, 2);
    assert.equal(first.skipped, 0);
    assert.equal(countLogs(db), 2);
    assert.equal(readLastLogTime(db), T0 + 60_000);

    const again = await run(db, fetchImpl);
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 2);
    assert.equal(countLogs(db), 2);
  } finally {
    cleanup();
  }
});

test('时间窗：有水位向前 30 分钟，空库取最近 3 天', async () => {
  assert.equal(resolveSinceMs({ lastTMs: T0, nowMs: NOW }), T0 - 30 * 60 * 1000);
  assert.equal(resolveSinceMs({ lastTMs: null, days: 3, nowMs: NOW }), NOW - 3 * DAY_MS);
  // --days 只影响空库，有水位时仍按水位往前 2 小时
  assert.equal(resolveSinceMs({ lastTMs: T0, days: 9, nowMs: NOW }), T0 - 30 * 60 * 1000);

  const seed = normalizeLogItem(makeItem({ id: 9001 }), { now: NOW });
  const { db, cleanup } = makeDb([seed]);
  try {
    const { fetchImpl } = exportHandler('');
    const summary = await run(db, fetchImpl);
    assert.equal(summary.lastTMs, T0);
    assert.equal(summary.sinceMs, T0 - 30 * 60 * 1000);
  } finally {
    cleanup();
  }
});

test('--dry-run：请求与统计照常，不写库', async () => {
  const { db, cleanup } = makeDb();
  try {
    const items = [makeItem(), makeItem({ id: 1002, created_at: Math.floor(T0 / 1000) + 60 })];
    const { fetchImpl } = exportHandler(ndjson(items));
    const summary = await run(db, fetchImpl, { dryRun: true });
    assert.equal(summary.rows, 2);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.wouldInsert, 2);
    assert.equal(countLogs(db), 0);
    assert.match(summary.report, /dry-run/);
  } finally {
    cleanup();
  }
});

test('失败响应（401 / 500 / success:false）不写库且错误可见', async () => {
  const cases = [
    { name: '401', fetch: exportHandler('', 401), pattern: /HTTP 401/ },
    { name: '500', fetch: exportHandler('', 500), pattern: /HTTP 500/ },
    {
      name: 'success:false',
      fetch: exportHandler(JSON.stringify({ success: false, message: '无效的令牌' })),
      pattern: /接口返回失败.*无效的令牌/,
    },
    {
      name: '分页 success:false',
      fetch: createMockFetch((u) => {
        if (u.pathname === '/api/log/export') return new Response('', { status: 404 });
        return jsonResponse({ success: false, message: '权限不足' });
      }),
      pattern: /接口返回失败.*权限不足/,
    },
  ];

  for (const c of cases) {
    const { db, cleanup } = makeDb();
    try {
      await assert.rejects(() => run(db, c.fetch.fetchImpl), c.pattern, c.name);
      assert.equal(countLogs(db), 0, `${c.name} 不应写库`);
    } finally {
      cleanup();
    }
  }
});

test('报告与错误信息不含 PAT 与日志原文；raw_json 入库前脱敏', async () => {
  const { db, cleanup } = makeDb();
  try {
    const items = [
      makeItem({
        content: 'SECRET-LOG-CONTENT',
        other: JSON.stringify({ note: 'SECRET-LOG-CONTENT' }),
        key: PAT,
      }),
    ];
    const { fetchImpl } = exportHandler(ndjson(items));
    const summary = await run(db, fetchImpl);
    assert.equal(summary.inserted, 1);
    assert.ok(!summary.report.includes(PAT), '报告不应含 PAT');
    assert.ok(!summary.report.includes('SECRET-LOG-CONTENT'), '报告不应含日志原文');

    const raw = db.prepare('SELECT raw_json FROM logs WHERE req_id = ?').get('1001');
    assert.ok(!String(raw.raw_json).includes(PAT), 'raw_json 应掩码令牌');
    assert.ok(String(raw.raw_json).includes('SECRET-LOG-CONTENT'), '非敏感原文按原样保留');
  } finally {
    cleanup();
  }

  const errDb = makeDb();
  try {
    const leaky = exportHandler(
      JSON.stringify({ success: false, message: `bad token ${PAT}` }),
    );
    await assert.rejects(
      () => run(errDb.db, leaky.fetchImpl),
      (err) => {
        assert.match(err.message, /接口返回失败/);
        assert.ok(!err.message.includes(PAT), '错误信息不应含 PAT');
        return true;
      },
    );
  } finally {
    errDb.cleanup();
  }
});

test('导出端点 404 时回退分页，翻到末页为止', async () => {
  const { db, cleanup } = makeDb();
  try {
    const items = [makeItem(), makeItem({ id: 1002, created_at: Math.floor(T0 / 1000) + 60 })];
    const { fetchImpl } = createMockFetch((u) => {
      if (u.pathname === '/api/log/export') return new Response('', { status: 404 });
      if (u.pathname === '/api/log') {
        const page = Number(u.searchParams.get('p'));
        assert.equal(u.searchParams.get('type'), '2');
        return jsonResponse({ success: true, data: { items: [items[page - 1]], total: 2 } });
      }
      throw new Error(`未预期的请求 ${u.pathname}`);
    });

    const summary = await run(db, fetchImpl, { pageSize: 1 });
    assert.equal(summary.transport, 'paged');
    assert.equal(summary.pages, 3); // 1 次导出 404 + 2 页
    assert.equal(summary.rows, 2);
    assert.equal(summary.inserted, 2);
    assert.equal(countLogs(db), 2);
  } finally {
    cleanup();
  }
});

test('分片：9 天窗口默认按 1 天切成 9 段，URL 首尾相接且覆盖完整区间', async () => {
  const { db, cleanup } = makeDb();
  try {
    const since = NOW - 9 * DAY_MS;
    const { fetchImpl, calls } = exportHandler('');
    // 不传 chunkDays，验证默认 1 天
    const summary = await runCollectSiteLogs({
      db,
      pat: PAT,
      source: 'http',
      baseUrl: 'https://relay.test',
      nowMs: NOW,
      sinceMs: since,
      fetchImpl,
      minIntervalMs: 0,
    });

    assert.equal(summary.chunks, 9);
    assert.equal(calls.length, 9);
    assert.equal(summary.pages, 9);
    assert.equal(summary.transport, 'export');
    assert.equal(calls[0].search.get('start_timestamp'), String(since / 1000));
    assert.equal(calls[8].search.get('end_timestamp'), String(NOW / 1000));
    for (let i = 1; i < calls.length; i++) {
      assert.equal(
        calls[i].search.get('start_timestamp'),
        calls[i - 1].search.get('end_timestamp'),
        `第 ${i + 1} 段应与上一段首尾相接`,
      );
    }
  } finally {
    cleanup();
  }
});

test('分片：每片独立入库，多片全量后再跑一次插入 0', async () => {
  const { db, cleanup } = makeDb();
  try {
    const since = NOW - 3 * DAY_MS;
    const sinceSec = since / 1000;
    const itemFor = (startSec) =>
      makeItem({
        id: 2000 + Math.round((startSec - sinceSec) / 86400),
        created_at: startSec + 3600,
        content: 'SECRET-LOG-CONTENT',
      });
    const handler = createMockFetch(
      (u) => new Response(ndjson([itemFor(Number(u.searchParams.get('start_timestamp')))]), { status: 200 }),
    );

    const lines = [];
    const first = await run(db, handler.fetchImpl, {
      sinceMs: since,
      chunkDays: 1,
      log: (line) => lines.push(line),
    });
    assert.equal(first.chunks, 3);
    assert.equal(first.rows, 3);
    assert.equal(first.inserted, 3);
    assert.equal(first.skipped, 0);
    assert.equal(countLogs(db), 3);

    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.match(
        line,
        /^分片 \d+\/3 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ~ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 行数 1 插入 1 跳过 0$/,
      );
      assert.ok(!line.includes('SECRET-LOG-CONTENT'), '分片进度不应含日志原文');
      assert.ok(!line.includes(PAT), '分片进度不应含 PAT');
    }

    const again = await run(db, handler.fetchImpl, { sinceMs: since, chunkDays: 1 });
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 3);
    assert.equal(countLogs(db), 3);
  } finally {
    cleanup();
  }
});

test('分片：第 2 段 500 时第 1 段已入库，错误带范围与已插入行数，不再请求第 3 段', async () => {
  const { db, cleanup } = makeDb();
  try {
    const since = NOW - 3 * DAY_MS;
    const sinceSec = since / 1000;
    let calls = 0;
    const handler = createMockFetch((u) => {
      calls++;
      const start = Number(u.searchParams.get('start_timestamp'));
      if (start === sinceSec + 86400) return new Response('', { status: 500 });
      assert.equal(start, sinceSec, '第 3 段不应被请求');
      return new Response(ndjson([makeItem({ id: 3001, created_at: start + 60 })]), { status: 200 });
    });

    await assert.rejects(
      () => run(db, handler.fetchImpl, { sinceMs: since, chunkDays: 1 }),
      (err) => {
        assert.match(err.message, /第 2\/3 段/);
        assert.match(err.message, /已插入 1 行/);
        return true;
      },
    );
    assert.equal(calls, 2);
    assert.equal(countLogs(db), 1);
  } finally {
    cleanup();
  }
});

test('分片失败信息脱敏：success:false 的 message 里的 PAT 被抹掉', async () => {
  const { db, cleanup } = makeDb();
  try {
    const since = NOW - 3 * DAY_MS;
    const sinceSec = since / 1000;
    const handler = createMockFetch((u) => {
      const start = Number(u.searchParams.get('start_timestamp'));
      if (start === sinceSec + 86400) {
        return new Response(JSON.stringify({ success: false, message: `bad token ${PAT}` }), { status: 200 });
      }
      return new Response(ndjson([makeItem({ id: 4001, created_at: start + 60 })]), { status: 200 });
    });

    await assert.rejects(
      () => run(db, handler.fetchImpl, { sinceMs: since, chunkDays: 1 }),
      (err) => {
        assert.match(err.message, /第 2\/3 段/);
        assert.ok(!err.message.includes(PAT), '错误信息不应含 PAT');
        return true;
      },
    );
    assert.equal(countLogs(db), 1);
  } finally {
    cleanup();
  }
});

test('--chunk-days=0：单请求覆盖完整窗口', async () => {
  const { db, cleanup } = makeDb();
  try {
    const since = NOW - 9 * DAY_MS;
    const { fetchImpl, calls } = exportHandler('');
    const summary = await run(db, fetchImpl, { sinceMs: since, chunkDays: 0 });
    assert.equal(summary.chunks, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].search.get('start_timestamp'), String(since / 1000));
    assert.equal(calls[0].search.get('end_timestamp'), String(NOW / 1000));
  } finally {
    cleanup();
  }
});

test('参数校验：--timeout-ms 必须是正整数，--chunk-days 接受 0 与小数', () => {
  for (const bad of ['--timeout-ms=0', '--timeout-ms=-1', '--timeout-ms=abc', '--timeout-ms=1.5']) {
    assert.throws(() => parseArgs([bad]), /timeout-ms 必须是正整数/, bad);
  }
  assert.equal(parseArgs(['--timeout-ms=300000']).timeoutMs, 300000);
  assert.equal(parseArgs(['--chunk-days=0']).chunkDays, 0);
  assert.equal(parseArgs(['--chunk-days=0.5']).chunkDays, 0.5);
  assert.throws(() => parseArgs(['--chunk-days=abc']), /chunk-days 不合法/);
  assert.throws(() => parseArgs(['--days=0']), /--days 不合法/);
});

test('--since 解析：13 位毫秒与 ISO8601（无时区按北京时间）', () => {
  assert.equal(parseSinceArg('1760000000000'), 1760000000000);
  assert.equal(parseSinceArg('2026-10-01T00:00:00'), Date.parse('2026-10-01T00:00:00+08:00'));
  assert.equal(parseSinceArg('2026-10-01'), Date.parse('2026-10-01T00:00:00+08:00'));
  assert.equal(parseSinceArg('2026-10-01T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(() => parseSinceArg('2026/10/01'), /--since/);
});

test('分页回退：首次 404 后整轮都走分页，不再逐片试探导出，page_size 仍 100', async () => {
  const { db, cleanup } = makeDb();
  try {
    const since = NOW - 3 * DAY_MS;
    let exportCalls = 0;
    const pageStarts = [];
    const handler = createMockFetch((u) => {
      if (u.pathname === '/api/log/export') {
        exportCalls++;
        return new Response('', { status: 404 });
      }
      if (u.pathname === '/api/log') {
        const start = Number(u.searchParams.get('start_timestamp'));
        pageStarts.push(start);
        assert.equal(u.searchParams.get('page_size'), '100');
        return jsonResponse({
          success: true,
          data: { items: [makeItem({ id: 5000 + pageStarts.length, created_at: start + 60 })], total: 1 },
        });
      }
      throw new Error(`未预期的请求 ${u.pathname}`);
    });

    const summary = await run(db, handler.fetchImpl, { sinceMs: since, chunkDays: 1 });
    assert.equal(summary.transport, 'paged');
    assert.equal(exportCalls, 1, '只有第 1 片试探导出');
    assert.equal(pageStarts.length, 3);
    assert.equal(summary.inserted, 3);
  } finally {
    cleanup();
  }
});

test('--since 必须早于当前时间，且不发出请求', async () => {
  const { db, cleanup } = makeDb();
  try {
    const { fetchImpl, calls } = exportHandler('');
    await assert.rejects(() => run(db, fetchImpl, { sinceMs: NOW }), /必须早于当前时间/);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 直读站点库（--source=db）：模拟 new-api 的本地 SQLite
// ---------------------------------------------------------------------------

const NEWAPI_SCHEMA = `CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  created_at INTEGER,
  type INTEGER,
  content TEXT,
  username TEXT,
  token_name TEXT,
  model_name TEXT,
  quota INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  use_time INTEGER,
  is_stream numeric,
  channel_id INTEGER,
  channel_name TEXT,
  token_id INTEGER,
  "group" TEXT,
  ip TEXT,
  request_id varchar(64),
  upstream_request_id varchar(128),
  other TEXT
)`;

function newApiRow(overrides = {}) {
  return {
    id: 1,
    user_id: 1,
    created_at: Math.floor(T0 / 1000),
    type: 2,
    content: 'hi',
    username: 'u1',
    token_name: 'tk-test',
    model_name: 'gpt-x',
    quota: 2500,
    prompt_tokens: 1000,
    completion_tokens: 120,
    use_time: 1,
    is_stream: 1,
    channel_id: 13,
    channel_name: '渠道一',
    token_id: 7,
    group: 'default',
    ip: '203.0.113.9',
    request_id: null,
    other: '{}',
    ...overrides,
  };
}

function insertNewApiRows(file, rows) {
  const raw = new DatabaseSync(file);
  try {
    const ins = raw.prepare(
      `INSERT INTO logs (id, user_id, created_at, type, content, username, token_name, model_name,
                         quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id,
                         channel_name, token_id, "group", ip, request_id, other)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(
        r.id,
        r.user_id,
        r.created_at,
        r.type,
        r.content,
        r.username,
        r.token_name,
        r.model_name,
        r.quota,
        r.prompt_tokens,
        r.completion_tokens,
        r.use_time,
        r.is_stream,
        r.channel_id,
        r.channel_name,
        r.token_id,
        r.group,
        r.ip,
        r.request_id,
        r.other,
      );
    }
  } finally {
    raw.close();
  }
}

/** 模拟 new-api 的源库：只建用到的列；channels 用于补渠道名 */
function makeNewApiDb(rows = [], channels = null) {
  const dir = makeTempDir('v2-newapi-');
  const file = path.join(dir, 'one-api.db');
  const raw = new DatabaseSync(file);
  raw.exec(NEWAPI_SCHEMA);
  if (Array.isArray(channels)) {
    raw.exec('CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT)');
    const insChannel = raw.prepare('INSERT INTO channels (id, name) VALUES (?, ?)');
    for (const c of channels) insChannel.run(c.id, c.name);
  }
  raw.close();
  insertNewApiRows(file, rows);
  return {
    file,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('直读：只写 type=2，channel_id → channel，created_at 秒转毫秒', async () => {
  const target = makeDb();
  const base = Math.floor(T0 / 1000);
  const src = makeNewApiDb([
    newApiRow({ id: 1, type: 1, created_at: base - 10 }),
    newApiRow({ id: 2, created_at: base, request_id: 'req-2' }),
    newApiRow({
      id: 3,
      created_at: base + 60,
      request_id: 'req-3',
      channel_id: 27,
      channel_name: '渠道二',
      is_stream: 0,
      quota: 500000,
      prompt_tokens: 500,
      completion_tokens: 60,
    }),
  ]);
  try {
    const summary = await runCollectSiteLogs({
      db: target.db,
      pat: null,
      source: 'db',
      dbFile: src.file,
      nowMs: NOW,
    });

    assert.equal(summary.source, 'db');
    assert.equal(summary.transport, 'db');
    assert.equal(summary.rows, 2, 'type=1 不应被拉出来');
    assert.equal(summary.inserted, 2);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.id_range, { min: 2, max: 3 });
    assert.equal(countLogs(target.db), 2);

    const second = target.db.prepare('SELECT * FROM logs WHERE req_id = ?').get('req-2');
    assert.equal(second.t_ms, T0, 'created_at 秒应转成毫秒');
    assert.equal(second.channel_id, 13, 'channel_id 应映射到 channel_id');
    assert.equal(second.channel_name, '渠道一');
    assert.equal(second.model, 'gpt-x');
    assert.equal(second.token_name, 'tk-test');
    assert.equal(second.group_name, 'default');
    assert.equal(second.is_stream, 1);
    assert.equal(second.input_total, 1000);
    assert.equal(second.input_uncached, 1000);
    assert.equal(second.output, 120);
    assert.equal(second.cost, 0.005);
    assert.equal(second.quota_raw, 2500);
    assert.equal(second.log_type, 2);
    assert.equal(second.latency_ms, 1000);

    const third = target.db.prepare('SELECT * FROM logs WHERE req_id = ?').get('req-3');
    assert.equal(third.channel_id, 27, 'channel 应取源库的 channel_id');
    assert.equal(third.channel_name, '渠道二');
    assert.equal(third.is_stream, 0);
    assert.equal(third.t_ms, T0 + 60_000);
    assert.equal(third.cost, 1);

    assert.match(summary.report, /直读 db/);
    assert.match(summary.report, /id 范围 2~3/);
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读：源库 channel_name 为 NULL 时用 channels.name 补齐，已有名字不覆盖', async () => {
  const target = makeDb();
  const base = Math.floor(T0 / 1000);
  const src = makeNewApiDb(
    [
      newApiRow({ id: 1, created_at: base, request_id: 'req-a', channel_id: 13, channel_name: null }),
      newApiRow({ id: 2, created_at: base + 60, request_id: 'req-b', channel_id: 43, channel_name: null }),
      newApiRow({ id: 3, created_at: base + 120, request_id: 'req-c', channel_id: 99, channel_name: null }),
      newApiRow({ id: 4, created_at: base + 180, request_id: 'req-d', channel_id: 13, channel_name: '旧名' }),
    ],
    [
      { id: 13, name: '国模 | 渠道一' },
      { id: 43, name: 'penguin kiro 高缓' },
    ],
  );
  try {
    const summary = await runCollectSiteLogs({
      db: target.db,
      pat: null,
      source: 'db',
      dbFile: src.file,
      nowMs: NOW,
    });
    assert.equal(summary.inserted, 4);

    const nameOf = (reqId) => target.db.prepare('SELECT channel_name FROM logs WHERE req_id = ?').get(reqId).channel_name;
    assert.equal(nameOf('req-a'), '国模 | 渠道一', 'NULL 应补成 channels.name');
    assert.equal(nameOf('req-b'), 'penguin kiro 高缓');
    assert.equal(nameOf('req-c'), null, '源库没有该渠道时不编造名字');
    assert.equal(nameOf('req-d'), '旧名', '源库自带的名字优先，不被覆盖');
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读：同一批再跑一次插入 0（幂等）', async () => {
  const target = makeDb();
  const src = makeNewApiDb([newApiRow({ id: 1 }), newApiRow({ id: 2, created_at: Math.floor(T0 / 1000) + 60 })]);
  try {
    const first = await runCollectSiteLogs({ db: target.db, pat: null, source: 'db', dbFile: src.file, nowMs: NOW });
    assert.equal(first.inserted, 2);

    const again = await runCollectSiteLogs({ db: target.db, pat: null, source: 'db', dbFile: src.file, nowMs: NOW });
    assert.equal(again.inserted, 0);
    // 水位边界那一行被 id 游标直接跳过，只剩最后一行重复
    assert.equal(again.rows, 1);
    assert.equal(again.skipped, 1);
    assert.equal(countLogs(target.db), 2);
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读水位：第二次只按 id 游标拉新增的 3 行', async () => {
  const target = makeDb();
  const base = Math.floor(T0 / 1000);
  const src = makeNewApiDb(
    [1, 2, 3].map((id) => newApiRow({ id, created_at: base + (id - 1) * 120, request_id: `r${id}` })),
  );
  try {
    const first = await runCollectSiteLogs({ db: target.db, pat: null, source: 'db', dbFile: src.file, nowMs: NOW });
    assert.equal(first.rows, 3);
    assert.equal(first.inserted, 3);

    insertNewApiRows(
      src.file,
      [4, 5, 6].map((id) => newApiRow({ id, created_at: base + 240 + (id - 3) * 60, request_id: `r${id}` })),
    );

    const second = await runCollectSiteLogs({ db: target.db, pat: null, source: 'db', dbFile: src.file, nowMs: NOW });
    assert.equal(second.rows, 3, '只应拉到新增的 3 行');
    assert.equal(second.inserted, 3);
    assert.equal(second.skipped, 0);
    assert.deepEqual(second.id_range, { min: 4, max: 6 });
    assert.equal(countLogs(target.db), 6);
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读水位：流量空档后的第一条新行不会被游标跳过', async () => {
  const base = Math.floor(T0 / 1000);
  const seed = normalizeLogItem(makeItem({ id: 9001, created_at: base }), { now: NOW });
  const target = makeDb([seed]);
  // 源库在窗口内只有一条更晚的行：按「跳过水位行」处理就会丢它
  const src = makeNewApiDb([newApiRow({ id: 2, created_at: base + 7200, request_id: 'r-gap' })]);
  try {
    const summary = await runCollectSiteLogs({ db: target.db, pat: null, source: 'db', dbFile: src.file, nowMs: NOW });
    assert.equal(summary.rows, 1);
    assert.equal(summary.inserted, 1);
    assert.deepEqual(summary.id_range, { min: 2, max: 2 });
    assert.ok(target.db.prepare('SELECT 1 AS ok FROM logs WHERE req_id = ?').get('r-gap'));
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读空库 + --since：从 since 起算，更早的行不拉', async () => {
  const target = makeDb();
  const base = Math.floor(T0 / 1000);
  const src = makeNewApiDb([
    newApiRow({ id: 1, created_at: base - 3600 }),
    newApiRow({ id: 2, created_at: base, request_id: 'r2' }),
    newApiRow({ id: 3, created_at: base + 60, request_id: 'r3' }),
  ]);
  try {
    const summary = await runCollectSiteLogs({
      db: target.db,
      pat: null,
      source: 'db',
      dbFile: src.file,
      sinceMs: T0,
      nowMs: NOW,
    });
    assert.equal(summary.rows, 2);
    assert.equal(summary.inserted, 2);
    assert.deepEqual(summary.id_range, { min: 2, max: 3 });
    assert.equal(countLogs(target.db), 2);
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读 dry-run：统计可插入行数，不写库', async () => {
  const target = makeDb();
  const src = makeNewApiDb([newApiRow({ id: 1 }), newApiRow({ id: 2, created_at: Math.floor(T0 / 1000) + 60 })]);
  try {
    const summary = await runCollectSiteLogs({
      db: target.db,
      pat: null,
      source: 'db',
      dbFile: src.file,
      nowMs: NOW,
      dryRun: true,
    });
    assert.equal(summary.rows, 2);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.wouldInsert, 2);
    assert.equal(countLogs(target.db), 0);
    assert.match(summary.report, /dry-run/);
  } finally {
    src.cleanup();
    target.cleanup();
  }
});

test('直读源库不存在：打一行提示并回退 HTTP 导出', async () => {
  const target = makeDb();
  const missingDir = makeTempDir('v2-newapi-missing-');
  const missing = path.join(missingDir, 'one-api.db');
  try {
    const { fetchImpl, calls } = exportHandler(ndjson([makeItem()]));
    const lines = [];
    const summary = await runCollectSiteLogs({
      db: target.db,
      pat: PAT,
      source: 'db',
      dbFile: missing,
      baseUrl: 'https://relay.test',
      nowMs: NOW,
      fetchImpl,
      minIntervalMs: 0,
      chunkDays: 0,
      log: (line) => lines.push(line),
    });

    assert.equal(summary.source, 'http', '应回退到 HTTP 源');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/log/export');
    assert.equal(summary.inserted, 1);
    assert.equal(countLogs(target.db), 1);
    assert.equal(lines.length, 2, '回退提示 + 1 条分片进度');
    assert.match(lines[0], /^\[collect-site-logs\] 直读失败，回退 HTTP 导出：/);
    assert.ok(!lines[0].includes(PAT), '回退提示不应含 PAT');
  } finally {
    fs.rmSync(missingDir, { recursive: true, force: true });
    target.cleanup();
  }
});

test('直读报告与错误信息不含 token 与日志正文；读库错误不回退 HTTP', async () => {
  const target = makeDb();
  const src = makeNewApiDb([
    newApiRow({
      id: 1,
      content: 'SECRET-LOG-CONTENT',
      token_name: PAT,
      other: JSON.stringify({ note: 'SECRET-LOG-CONTENT' }),
    }),
  ]);
  const badDir = makeTempDir('v2-newapi-bad-');
  const badFile = path.join(badDir, 'one-api.db');
  try {
    const summary = await runCollectSiteLogs({ db: target.db, pat: null, source: 'db', dbFile: src.file, nowMs: NOW });
    assert.equal(summary.inserted, 1);
    assert.ok(!summary.report.includes(PAT), '报告不应含 token');
    assert.ok(!summary.report.includes('SECRET-LOG-CONTENT'), '报告不应含日志正文');

    const raw = target.db.prepare('SELECT raw_json FROM logs WHERE req_id = ?').get('1');
    assert.ok(!String(raw.raw_json).includes(PAT), 'raw_json 应掩码 sk- 串');
    assert.ok(String(raw.raw_json).includes('SECRET-LOG-CONTENT'), '非敏感原文按原样保留');

    // schema 变化（缺 type 列）：打开成功但读取失败 → 报错，不回退 HTTP
    const rawDb = new DatabaseSync(badFile);
    rawDb.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, created_at INTEGER, content TEXT)');
    rawDb.exec(`INSERT INTO logs (id, created_at, content) VALUES (1, ${Math.floor(T0 / 1000)}, 'SECRET-LOG-CONTENT')`);
    rawDb.close();

    let fetchCalls = 0;
    await assert.rejects(
      () =>
        runCollectSiteLogs({
          db: target.db,
          pat: PAT,
          source: 'db',
          dbFile: badFile,
          nowMs: NOW,
          fetchImpl: async () => {
            fetchCalls++;
            throw new Error('不应回退 HTTP');
          },
        }),
      (err) => {
        assert.match(err.message, /读取源库失败/);
        assert.ok(!err.message.includes('SECRET-LOG-CONTENT'), '错误信息不应含日志正文');
        return true;
      },
    );
    assert.equal(fetchCalls, 0, '读库错误不回退 HTTP');
  } finally {
    fs.rmSync(badDir, { recursive: true, force: true });
    src.cleanup();
    target.cleanup();
  }
});

test('--source / --db-file 参数：默认 db，源库路径来自实例配置', () => {
  const def = parseArgs([]);
  assert.equal(def.source, 'db');
  assert.equal(def.dbFile, DEFAULT_DB_FILE);
  assert.equal(DEFAULT_DB_FILE, INSTANCE.paths.relayDb);
  assert.equal(parseArgs(['--source=http']).source, 'http');
  assert.equal(parseArgs(['--db-file=/tmp/x.db']).dbFile, '/tmp/x.db');
  assert.equal(parseArgs(['--base-url=https://example.test']).baseUrl, 'https://example.test');
  assert.equal(parseArgs(['--site-id=demo']).siteId, 'demo');
  assert.throws(() => parseArgs(['--source=ftp']), /--source 只支持 db 或 http/);
  assert.throws(() => parseArgs(['--db-file=']), /--db-file 不能为空/);
});


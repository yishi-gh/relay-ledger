/**
 * collect-http-errors / http_errors_hourly 单测：解析、北京整点、增量位点、轮转、dry-run、坏行、汇总。
 * 全部用临时日志与临时 sqlite，不读生产日志、不碰仓库里的真实库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  beijingHourStart,
  classifyRequest,
  main,
  parseAccessLine,
  parseArgs,
  runCollectHttpErrors,
} from '../jobs/collect-http-errors.mjs';
import {
  readErrorBuckets,
  readOffset,
  summarizeBuckets,
  upsertBuckets,
  writeOffset,
} from '../store/http-errors.mjs';
import {
  DEFAULT_HTTP_ERRORS_INTERVAL_MS,
  HTTP_ERRORS_INITIAL_DELAY_MS,
  splitHttpErrorsArgs,
  TASK_HTTP_ERRORS,
} from '../jobs/run-scheduler.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const HOUR = 3_600_000;
/** 08/Nov/2026:13:22:33 +0000 对应北京时间 21:00 整点 */
const HOUR_MS = Date.UTC(2026, 10, 8, 13, 0, 0);

function nginxLine({
  ip = '1.2.3.4',
  time = '08/Nov/2026:13:22:33 +0000',
  request = 'GET / HTTP/1.1',
  status = 200,
  bytes = 123,
} = {}) {
  return `${ip} - - [${time}] "${request}" ${status} ${bytes} "-" "curl/8.0.1"\n`;
}

function setup() {
  const dir = makeTempDir('v2-http-errors-');
  return {
    dir,
    logFile: path.join(dir, 'access.log'),
    dbFile: path.join(dir, 'dashboard.db'),
  };
}

function runQuiet(options) {
  const lines = [];
  const result = runCollectHttpErrors({
    ...options,
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
  });
  return { result, lines };
}

function bucketRows(db, from = HOUR_MS, to = HOUR_MS + HOUR - 1) {
  return readErrorBuckets(db, from, to);
}

test('解析 3 行：200 忽略，404/500 各入桶，hour_ms 为北京整点', () => {
  const { logFile, dbFile } = setup();
  fs.writeFileSync(
    logFile,
    nginxLine({ status: 200, request: 'GET /v1/models HTTP/1.1' }) +
      nginxLine({ status: 404, request: 'POST /v1/chat/completions?x=1 HTTP/1.1' }) +
      nginxLine({ status: 500, request: 'GET /api/user/self HTTP/1.1' }),
  );
  const db = openDashboardDb(dbFile);
  try {
    const { result, lines } = runQuiet({ file: logFile, dbFile });

    assert.equal(result.missing, false);
    assert.equal(result.lines, 3);
    assert.equal(result.errors, 2);
    assert.equal(result.bad, 0);
    assert.equal(result.buckets, 2);
    assert.equal(result.offset, fs.statSync(logFile).size);

    const rows = bucketRows(db);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.hour_ms, r.status, r.path_group, r.count]),
      [
        [HOUR_MS, 404, '/v1', 1],
        [HOUR_MS, 500, '/api', 1],
      ],
    );
    assert.equal(readOffset(db), fs.statSync(logFile).size);
    assert.match(lines[0], /^\[collect-http-errors\] 读取 3 行 · 4xx\/5xx 2 行 · 写入 2 桶 · offset→\d+$/);
    assert.ok(!lines.join('\n').includes('1.2.3.4'), '输出不能带日志原文/IP');
  } finally {
    db.close();
  }
});

test('时间与路径组：识别 +0800 偏移，/v10 不算 /v1', () => {
  // 21:22:33 +0800 与 13:22:33 +0000 是同一时刻
  const line = nginxLine({ time: '08/Nov/2026:21:22:33 +0800', request: 'GET /v1/models HTTP/1.1' });
  const parsed = parseAccessLine(line);
  assert.equal(parsed.hour_ms, HOUR_MS);
  assert.equal(parsed.path_group, '/v1');
  assert.equal(beijingHourStart(Date.UTC(2026, 10, 8, 13, 59, 59)), HOUR_MS);

  assert.equal(classifyRequest('GET /v1 HTTP/1.1'), '/v1');
  assert.equal(classifyRequest('GET /v1/ HTTP/1.1'), '/v1');
  assert.equal(classifyRequest('GET /api HTTP/1.1'), '/api');
  assert.equal(classifyRequest('GET /api/v1/auth/me HTTP/1.1'), '/api');
  assert.equal(classifyRequest('GET /v10/x HTTP/1.1'), 'other');
  assert.equal(classifyRequest('GET /healthz HTTP/1.1'), 'other');
  assert.equal(classifyRequest('-'), 'other');
});

test('同小时同状态同组累加：count 翻倍，不新增行', () => {
  const { logFile, dbFile } = setup();
  fs.writeFileSync(logFile, nginxLine({ status: 404, request: 'GET /v1/a HTTP/1.1' }));
  const db = openDashboardDb(dbFile);
  try {
    runQuiet({ file: logFile, dbFile });
    fs.appendFileSync(logFile, nginxLine({ status: 404, request: 'GET /v1/a HTTP/1.1' }));
    const { result } = runQuiet({ file: logFile, dbFile });

    assert.equal(result.lines, 1);
    assert.equal(result.errors, 1);
    assert.equal(result.buckets, 1);
    const rows = bucketRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
  } finally {
    db.close();
  }
});

test('增量：第二次只读追加部分，总行数 = 3 + 2', () => {
  const { logFile, dbFile } = setup();
  fs.writeFileSync(
    logFile,
    nginxLine({ status: 200, request: 'GET /healthz HTTP/1.1' }) +
      nginxLine({ status: 404, request: 'GET /v1/a HTTP/1.1' }) +
      nginxLine({ status: 500, request: 'GET /api/b HTTP/1.1' }),
  );
  const db = openDashboardDb(dbFile);
  try {
    const first = runQuiet({ file: logFile, dbFile });
    assert.equal(first.result.lines, 3);
    assert.equal(first.result.errors, 2);
    const firstOffset = first.result.offset;

    fs.appendFileSync(
      logFile,
      nginxLine({ status: 402, request: 'GET /v1/c HTTP/1.1' }) +
        nginxLine({ status: 503, request: 'GET /api/d HTTP/1.1' }),
    );
    const second = runQuiet({ file: logFile, dbFile });
    assert.equal(second.result.lines, 2);
    assert.equal(second.result.errors, 2);
    assert.equal(second.result.offset, fs.statSync(logFile).size);
    assert.ok(second.result.offset > firstOffset);

    const total = bucketRows(db).reduce((sum, row) => sum + row.count, 0);
    assert.equal(total, 4);
    assert.equal(readOffset(db), fs.statSync(logFile).size);
  } finally {
    db.close();
  }
});

test('轮转：文件截短后位点归零重读，不报错', () => {
  const { logFile, dbFile } = setup();
  fs.writeFileSync(
    logFile,
    nginxLine({ status: 404, request: 'GET /v1/a HTTP/1.1' }) +
      nginxLine({ status: 404, request: 'GET /v1/b HTTP/1.1' }) +
      nginxLine({ status: 404, request: 'GET /v1/c HTTP/1.1' }),
  );
  const db = openDashboardDb(dbFile);
  try {
    const first = runQuiet({ file: logFile, dbFile });
    assert.equal(first.result.offset, fs.statSync(logFile).size);

    fs.writeFileSync(logFile, ''); // 截断到 0：size < 旧 offset
    fs.writeFileSync(logFile, nginxLine({ status: 500, request: 'GET /api/x HTTP/1.1' }));
    const second = runQuiet({ file: logFile, dbFile });

    assert.ok(fs.statSync(logFile).size < first.result.offset, '新文件必须小于旧位点');
    assert.equal(second.result.lines, 1);
    assert.equal(second.result.errors, 1);
    assert.equal(second.result.offset, fs.statSync(logFile).size);
    const rows = bucketRows(db);
    assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 4);
  } finally {
    db.close();
  }
});

test('dry-run：解析并统计，但不写库、不写 offset', () => {
  const { dir, logFile, dbFile } = setup();
  fs.writeFileSync(
    logFile,
    nginxLine({ status: 404, request: 'GET /v1/a HTTP/1.1' }) +
      nginxLine({ status: 500, request: 'GET /api/b HTTP/1.1' }),
  );
  const db = openDashboardDb(dbFile);
  const before = readOffset(db);
  try {
    const { result, lines } = runQuiet({ file: logFile, dbFile, dryRun: true });
    assert.equal(result.lines, 2);
    assert.equal(result.errors, 2);
    assert.equal(result.buckets, 2);
    assert.equal(readErrorBuckets(db, HOUR_MS, HOUR_MS + HOUR - 1).length, 0);
    assert.equal(readOffset(db), before);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /dry-run/);
    assert.match(lines[0], /未落库/);
  } finally {
    db.close();
  }

  // 库文件不存在时 dry-run 也不创建
  const missingDb = path.join(dir, 'never-created.db');
  runQuiet({ file: logFile, dbFile: missingDb, dryRun: true });
  assert.equal(fs.existsSync(missingDb), false);
});

test('坏行：缺引号/缺字段跳过并计入 bad，不抛错', () => {
  const { logFile, dbFile } = setup();
  fs.writeFileSync(
    logFile,
    nginxLine({ status: 404, request: 'GET /v1/ok HTTP/1.1' }) +
      '1.2.3.4 - - [08/Nov/2026:13:22:33 +0000] "GET /v1/x HTTP/1.1" 500\n' + // 缺 referer/UA
      'garbage line\n' +
      nginxLine({ time: '99/Foo/2026:13:22:33 +0000', status: 500 }),
  );
  const db = openDashboardDb(dbFile);
  try {
    const { result, lines } = runQuiet({ file: logFile, dbFile });
    assert.equal(result.lines, 4);
    assert.equal(result.bad, 3);
    assert.equal(result.errors, 1);
    assert.equal(result.buckets, 1);
    assert.equal(bucketRows(db)[0].status, 404);
    assert.match(lines[0], /坏行 3/);
    assert.ok(!lines.join('\n').includes('garbage'), '输出不能带坏行原文');
  } finally {
    db.close();
  }
});

test('CLI 参数：--file / --db 同时接受等号与空格写法，空格缺值报错', () => {
  const { dir } = setup();
  const logFile = path.join(dir, 'access.log');
  const dbFile = path.join(dir, 'dashboard.db');

  assert.deepEqual(parseArgs(['--file', logFile, '--db', dbFile, '--dry-run']), {
    help: false,
    file: logFile,
    dbFile,
    dryRun: true,
    fromStart: false,
  });
  assert.deepEqual(parseArgs([`--file=${logFile}`, `--db=${dbFile}`, '--from-start']), {
    help: false,
    file: logFile,
    dbFile,
    dryRun: false,
    fromStart: true,
  });

  assert.throws(() => parseArgs(['--file']), /--file 不能为空/);
  assert.throws(() => parseArgs(['--db']), /--db 不能为空/);
  assert.throws(() => parseArgs(['--file=']), /--file 不能为空/);
});

test('文件不存在：只打一行 warn，退出码 0', () => {
  const { dir, dbFile } = setup();
  const missing = path.join(dir, 'nope.log');
  const lines = [];
  const code = main(['--file=' + missing, '--db=' + dbFile], {
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /warn.*不存在/);
});

test('调度参数：--no-http-errors 与默认间隔', () => {
  assert.equal(TASK_HTTP_ERRORS, 'http-errors');
  assert.equal(HTTP_ERRORS_INITIAL_DELAY_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_HTTP_ERRORS_INTERVAL_MS, 15 * 60 * 1000);
  assert.deepEqual(splitHttpErrorsArgs(['--no-http-errors', '--once']), {
    httpErrors: { enabled: false },
    rest: ['--once'],
  });
  assert.deepEqual(splitHttpErrorsArgs(['--once']), {
    httpErrors: { enabled: true },
    rest: ['--once'],
  });
});

test('summarizeBuckets：总数与 by_status / by_group / by_hour', () => {
  const rows = [
    { hour_ms: HOUR_MS, status: 404, path_group: '/v1', count: 3 },
    { hour_ms: HOUR_MS, status: 500, path_group: '/api', count: 2 },
    { hour_ms: HOUR_MS + HOUR, status: 404, path_group: '/v1', count: 1 },
    { hour_ms: HOUR_MS + HOUR, status: 429, path_group: 'other', count: 1 },
  ];
  assert.deepEqual(summarizeBuckets(rows), {
    total: 7,
    by_status: [
      { status: 404, count: 4 },
      { status: 429, count: 1 },
      { status: 500, count: 2 },
    ],
    by_group: [
      { path_group: '/v1', count: 4 },
      { path_group: '/api', count: 2 },
      { path_group: 'other', count: 1 },
    ],
    by_hour: [
      { hour_ms: HOUR_MS, count: 5 },
      { hour_ms: HOUR_MS + HOUR, count: 2 },
    ],
  });
  assert.deepEqual(summarizeBuckets([]), { total: 0, by_status: [], by_group: [], by_hour: [] });
});

test('upsertBuckets / writeOffset：直接写入同一桶会累加，位点可读回', () => {
  const { dbFile } = setup();
  const db = openDashboardDb(dbFile);
  try {
    assert.equal(readOffset(db), 0);
    assert.equal(writeOffset(db, 1234, 1000), 1234);
    assert.equal(readOffset(db), 1234);

    const row = { hour_ms: HOUR_MS, status: 404, path_group: '/v1', count: 2 };
    assert.equal(upsertBuckets(db, [row], 1000), 1);
    assert.equal(upsertBuckets(db, [row], 2000), 1);
    const rows = bucketRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 4);
  } finally {
    db.close();
  }

  // 缺少 schema_meta 的库读位点按 0 处理
  const bareFile = path.join(path.dirname(dbFile), 'bare.db');
  const bare = new DatabaseSync(bareFile);
  try {
    assert.equal(readOffset(bare), 0);
  } finally {
    bare.close();
  }
});

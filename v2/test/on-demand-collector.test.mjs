/** 真实 HTTP 入队与独立常驻进程的接线验证；所有源库、配置和凭据路径均隔离。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCollectionRefreshStore } from '../lib/collection-refresh.mjs';
import { createApiCache, createRequestHandler } from '../server.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { LOGS_SCHEMA } from '../store/site-logs.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

test('面板 POST 的补采请求由真实采集进程消费，写入本地副本且源库保持不变', { timeout: 20_000 }, async (t) => {
  const dir = makeTempDir('v2-demand-process-');
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const logsFile = path.join(dir, 'db', 'sites', 'isolated-test.db');
  fs.mkdirSync(path.dirname(logsFile), { recursive: true });
  const logs = new DatabaseSync(logsFile);
  logs.exec(LOGS_SCHEMA);
  const rawFile = path.join(dir, 'source.db');
  const raw = new DatabaseSync(rawFile);
  raw.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, created_at INTEGER, type INTEGER,
      model_name TEXT, quota INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
      channel_id INTEGER, request_id TEXT, other TEXT);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, type INTEGER, status INTEGER,
      base_url TEXT, model_mapping TEXT);
    CREATE TABLE abilities ("group" TEXT, model TEXT, channel_id INTEGER, enabled INTEGER);
    INSERT INTO channels VALUES (13, '隔离渠道', 1, 1, 'https://example.invalid', NULL)`);
  raw.prepare('INSERT INTO logs VALUES (1, ?, 2, ?, 1000, 10, 2, 13, ?, ?)')
    .run(Math.floor(Date.now() / 1000) - 1, 'fixture-model', 'fixture-request', '{}');
  raw.close();
  const sourceBytes = fs.readFileSync(rawFile);
  const accountsFile = path.join(dir, 'accounts.json');
  const tokenFile = path.join(dir, 'token.txt');
  const configFile = path.join(dir, 'instance.json');
  fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
  fs.writeFileSync(tokenFile, '');
  fs.writeFileSync(configFile, JSON.stringify({
    site: { id: 'isolated-test', name: '隔离测试', base_url: 'http://127.0.0.1:1' },
    paths: { data_dir: dir, relay_db: rawFile, accounts: accountsFile, site_token: tokenFile },
    collect: { source: 'db', logs_interval_ms: 3_600_000, spend_interval_ms: 3_600_000 },
  }));
  const store = createCollectionRefreshStore(dashboard);
  const server = http.createServer(createRequestHandler({ api: {}, cache: createApiCache(), collectionStore: store }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const collector = spawn(process.execPath, [
    fileURLToPath(new URL('../jobs/run-scheduler.mjs', import.meta.url)),
    `--config=${configFile}`, '--no-http-errors', '--no-upstream-errors', '--no-prune',
  ], { cwd: dir, env: { ...process.env, RELAY_LEDGER_INSTANCE: configFile, RELAY_ALERT_WEBHOOK: '' }, windowsHide: true });
  let output = '';
  collector.stdout.setEncoding('utf8');
  collector.stderr.setEncoding('utf8');
  collector.stdout.on('data', (chunk) => { output += chunk; });
  collector.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (collector.exitCode === null && collector.signalCode === null) {
      const exited = once(collector, 'exit');
      collector.kill();
      await exited;
    }
    await new Promise((resolve) => server.close(resolve));
    logs.close();
    dashboard.close();
    const resolved = path.resolve(dir);
    assert.ok(resolved.includes('v2-demand-process-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  while (!output.includes('常驻启动')) {
    assert.equal(collector.exitCode, null, output);
    assert.ok(Date.now() < deadline, `采集进程未就绪：${output}`);
    await delay(20);
  }
  const queued = await fetch(`${base}/api/refresh`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: 'models', force: false }),
  });
  assert.equal(queued.status, 202);
  const initial = await queued.json();
  const target = initial.groups[0].request_id;
  let progress;
  do {
    assert.ok(Date.now() < deadline, `补采未完成：${output}`);
    await delay(25);
    progress = await (await fetch(`${base}/api/refresh?view=models`)).json();
  } while (progress.groups[0].completed_id < target);
  assert.equal(progress.groups[0].error, null, output);
  assert.ok(progress.groups[0].last_success_at > 0);
  assert.notEqual(progress.revision, initial.revision);
  assert.equal(logs.prepare('SELECT COUNT(*) AS n FROM logs WHERE model = ?').get('fixture-model').n, 1);
  assert.equal(store.read(['routes']).groups[0].error, null, '日志任务复用渠道快照执行入口');
  assert.deepEqual(fs.readFileSync(rawFile), sourceBytes, '源库内容未改变');
});

/** 按需采集状态与执行入口：临时 SQLite、假时钟和注入任务，不访问上游。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  createCollectionRefreshStore,
  createOnDemandCollector,
  resourcesForView,
} from '../lib/collection-refresh.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const BASE = Date.UTC(2026, 10, 18);
const ALL_RESOURCES = ['logs', 'errors', 'httpErrors', 'spend', 'routes'];
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeClock() {
  let time = BASE;
  const intervals = new Set();
  return {
    now: () => time,
    set(value) { time = value; },
    intervals,
    setInterval(fn, ms) {
      const handle = { fn, ms, at: time + ms };
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle) { intervals.delete(handle); },
    async advance(ms) {
      const until = time + ms;
      while (true) {
        const next = [...intervals].filter((entry) => entry.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        time = next.at;
        next.at += next.ms;
        next.fn();
        await nextTurn();
      }
      time = until;
      await nextTurn();
    },
  };
}

function fixture(t, { registered = ['logs'] } = {}) {
  const dir = makeTempDir('v2-collection-refresh-');
  const file = path.join(dir, 'dashboard.db');
  const db = openDashboardDb(file);
  const connections = [db];
  const collectors = [];
  const gates = [];
  const clock = fakeClock();
  const alive = new Set([101, 202]);
  const errors = [];
  const options = (pid) => ({ now: clock.now, isAlive: (owner) => alive.has(owner), pid });
  const store = createCollectionRefreshStore(db, options(101));
  if (registered !== null) store.register(registered);
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.all(collectors.map((collector) => collector.stop()));
    for (const connection of connections) connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    file, db, store, clock, alive, errors,
    group: (resource = 'logs') => store.read([resource]).groups[0],
    heartbeatAt(time) {
      clock.set(time);
      store.heartbeat(ALL_RESOURCES);
    },
    connect(pid) {
      const connection = openDashboardDb(file);
      connections.push(connection);
      alive.add(pid);
      return createCollectionRefreshStore(connection, options(pid));
    },
    collector(tasks, selectedStore = store) {
      const collector = createOnDemandCollector({
        store: selectedStore, tasks, resources: Object.keys(tasks), timer: clock,
        logError: (message) => errors.push(message),
      });
      collectors.push(collector);
      return collector;
    },
    hold() {
      const gate = deferred();
      gates.push(gate);
      return gate;
    },
  };
}

function finishSuccess(store, resource) {
  const attempt = store.claim(resource);
  assert.ok(attempt, `${resource} 应能认领`);
  store.finish(resource, attempt);
  return attempt;
}

test('余额部分成功显示已写入和异常账户，并按五分钟复用可用数据', async (t) => {
  const fx = fixture(t, { registered: ['spend'] });
  finishSuccess(fx.store, 'spend');
  const at = BASE + 60_000;
  fx.heartbeatAt(at);
  const accounts = [
    ...Array.from({ length: 7 }, (_, i) => ({ name: `账户 ${i + 1}`, balance: { status: 'ok' }, written: { balance: true } })),
    { name: '网络异常账户', balance: { status: 'unavailable', reason: 'network_error' } },
    { name: '未配置账户', balance: { status: 'unconfigured' } },
  ];
  const collector = fx.collector({ spend: async () => {
    fx.db.prepare('INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, ?)')
      .run('collect-spend', at, at, 'partial', JSON.stringify({ accounts }));
    return { status: 'partial', accounts };
  } });
  await collector.run('spend');
  const group = fx.connect(202).read(['spend']).groups[0];
  assert.equal(group.state, 'partial');
  assert.equal(group.error, null);
  assert.equal(group.last_success_at, BASE);
  assert.equal(group.spend_result.updated_accounts.length, 7);
  assert.deepEqual(group.spend_result.issues, [
    { name: '网络异常账户', reason: '网络错误' },
    { name: '未配置账户', reason: '未配置余额来源' },
  ]);
  fx.heartbeatAt(at + 29_999);
  assert.equal(fx.store.request(['spend'], { force: true }).groups[0].state, 'partial');
  fx.heartbeatAt(at + 299_999);
  assert.equal(fx.store.request(['spend']).groups[0].state, 'partial');
  fx.heartbeatAt(at + 300_000);
  assert.equal(fx.store.request(['spend']).groups[0].state, 'queued');
});

test('页面白名单只请求该页需要的数据，设置页不采集，拒绝原型属性和未知页', () => {
  const expected = {
    overview: ['routes', 'spend', 'logs'],
    profit: ['routes', 'spend', 'logs'],
    rank: ['routes', 'logs', 'errors'],
    models: ['logs'],
    channels_detail: ['routes', 'logs', 'errors'],
    groups_detail: ['routes', 'logs', 'errors'],
    upstreams: ['routes', 'spend', 'logs'],
    routes: ['routes', 'logs', 'errors'],
    quality: ['routes', 'spend', 'logs', 'errors'],
    system: ['errors', 'httpErrors'],
    settings: [],
  };
  for (const [view, resources] of Object.entries(expected)) {
    assert.deepEqual([...resourcesForView(view)].sort(), [...resources].sort(), view);
  }
  for (const view of ['', 'unknown', 'logs', '__proto__', 'constructor', 'toString', undefined]) {
    assert.throws(() => resourcesForView(view), RangeError, String(view));
  }
});

for (const [resource, ttl] of [
  ['logs', 60_000], ['routes', 60_000], ['errors', 60_000],
  ['httpErrors', 60_000], ['spend', 300_000],
]) {
  test(`${resource}：未过 ${ttl / 60_000} 分钟复用成功结果，恰好到期才入队`, (t) => {
    const fx = fixture(t, { registered: [resource] });
    const cold = fx.store.request([resource]);
    assert.equal(cold.groups[0].state, 'queued');
    assert.equal(cold.groups[0].last_success_at, null);
    finishSuccess(fx.store, resource);

    fx.heartbeatAt(BASE + ttl - 1);
    const fresh = fx.store.request([resource]).groups[0];
    assert.equal(fresh.request_id, 1);
    assert.equal(fresh.completed_id, 1);
    assert.equal(fresh.last_success_at, BASE);

    fx.heartbeatAt(BASE + ttl);
    const expired = fx.store.request([resource]).groups[0];
    assert.equal(expired.state, 'queued');
    assert.equal(expired.request_id, 2);
    assert.equal(expired.completed_id, 1);
    assert.equal(expired.last_success_at, BASE, '入队不能伪装成采集成功');
  });
}

test('升级注册沿用已有成功采集时间，较新的失败或部分成功不冒充成功', (t) => {
  const fx = fixture(t, { registered: null });
  const insert = fx.db.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status) VALUES (?, ?, ?, ?)',
  );
  insert.run('collect-site-logs', BASE - 50_000, BASE - 40_000, 'ok');
  insert.run('collect-site-logs', BASE - 30_000, BASE - 20_000, 'error');
  insert.run('collect-site-logs', BASE - 10_000, BASE - 5_000, 'partial');
  fx.store.register(['logs', 'spend']);
  assert.equal(fx.group().last_success_at, BASE - 50_000);
  assert.equal(fx.group('spend').last_success_at, null, '注册本身不算成功');
  finishSuccess(fx.store, 'logs');
  fx.clock.set(BASE + 1_000);
  fx.store.register(['logs', 'spend']);
  assert.equal(fx.group().last_success_at, BASE, '再次注册不覆盖新的成功时间');
});

test('只读状态不建行、不恢复死进程、不改变 revision 或数据库', (t) => {
  const fx = fixture(t, { registered: null });
  const changes = () => fx.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const empty = fx.store.read(['logs']);
  assert.equal(empty.groups[0].state, 'disabled');
  assert.equal(changes(), before);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM collection_refresh').get().n, 0);

  fx.store.register(['logs']);
  fx.store.request(['logs']);
  fx.store.claim('logs');
  fx.alive.delete(101);
  const snapshot = fx.db.prepare('SELECT * FROM collection_refresh ORDER BY resource').all();
  const written = changes();
  const revision = fx.store.read(['logs']).revision;
  assert.equal(fx.store.read(['logs']).revision, revision);
  assert.equal(changes(), written);
  assert.deepEqual(fx.db.prepare('SELECT * FROM collection_refresh ORDER BY resource').all(), snapshot);
});

test('重复请求和运行期间的强制请求合并，revision 只随完成结果改变', (t) => {
  const fx = fixture(t);
  const initial = fx.store.read(['logs']).revision;
  for (let i = 0; i < 20; i += 1) {
    const group = fx.store.request(['logs', 'logs'], { force: true }).groups[0];
    assert.equal(group.state, 'queued');
    assert.equal(group.request_id, 1);
  }
  const attempt = fx.store.claim('logs');
  const running = fx.store.request(['logs'], { force: true });
  assert.equal(running.groups[0].state, 'running');
  assert.equal(running.groups[0].request_id, 1);
  assert.equal(running.revision, initial);
  fx.store.finish('logs', attempt);
  assert.equal(fx.group().completed_id, 1);
  assert.notEqual(fx.store.read(['logs']).revision, initial);
});

test('多资源请求遇到非法资源整体回滚，不留下部分入队', (t) => {
  const fx = fixture(t);
  const before = fx.store.read(ALL_RESOURCES);
  assert.throws(() => fx.store.request(['logs', '__proto__'], { force: true }), RangeError);
  assert.deepEqual(fx.store.read(ALL_RESOURCES), before);
});

for (const [resource, cooldown] of [['logs', 10_000], ['spend', 30_000]]) {
  test(`${resource}：主动刷新越过新鲜度，但不能越过 ${cooldown / 1000} 秒成功冷却`, (t) => {
    const fx = fixture(t, { registered: [resource] });
    finishSuccess(fx.store, resource);
    fx.heartbeatAt(BASE + cooldown - 1);
    const cooling = fx.store.request([resource], { force: true }).groups[0];
    assert.equal(cooling.state, 'cooldown');
    assert.equal(cooling.request_id, 1);
    assert.equal(cooling.retry_at, BASE + cooldown);
    fx.heartbeatAt(BASE + cooldown);
    assert.equal(fx.store.request([resource]).groups[0].request_id, 1);
    assert.equal(fx.store.request([resource], { force: true }).groups[0].state, 'queued');
    assert.equal(fx.group(resource).request_id, 2);
  });
}

test('首次失败保持未成功，连续失败指数退避至五分钟，成功后退避重置', (t) => {
  const fx = fixture(t);
  let previousSuccess = null;
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    const queued = fx.store.request(['logs'], { force: true }).groups[0];
    assert.equal(queued.state, 'queued');
    const attempt = fx.store.claim('logs');
    const failedAt = fx.clock.now();
    fx.store.finish('logs', attempt, '上游暂不可用');
    const failed = fx.group();
    assert.equal(failed.last_success_at, previousSuccess);
    assert.equal(failed.last_attempt_at, failedAt);
    assert.equal(failed.completed_id, queued.request_id);
    assert.equal(failed.retry_at, failedAt + delay);
    assert.match(failed.error, /上游暂不可用/);
    fx.heartbeatAt(failedAt + delay - 1);
    assert.equal(fx.store.request(['logs'], { force: true }).groups[0].request_id, queued.request_id);
    fx.heartbeatAt(failedAt + delay);
    assert.equal(fx.group().state, 'error', '退避结束仍应显示失败原因');
  }
  fx.store.request(['logs'], { force: true });
  previousSuccess = fx.clock.now();
  finishSuccess(fx.store, 'logs');
  assert.equal(fx.group().error, null);
  assert.equal(fx.group().last_success_at, previousSuccess);
  fx.heartbeatAt(fx.clock.now() + 10_000);
  fx.store.request(['logs'], { force: true });
  const attempt = fx.store.claim('logs');
  fx.store.finish('logs', attempt, '再次失败');
  assert.equal(fx.group().retry_at, fx.clock.now() + 30_000);
  assert.equal(fx.group().last_success_at, previousSuccess);
});

test('关闭采集项和心跳超时不能强制入队，九十秒边界和恢复心跳有效', (t) => {
  const fx = fixture(t, { registered: [] });
  const disabled = fx.store.request(['logs'], { force: true }).groups[0];
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.request_id, 0);
  assert.ok(disabled.error);
  fx.store.register(['logs']);
  fx.clock.set(BASE + 90_000);
  assert.equal(fx.store.request(['logs'], { force: true }).groups[0].state, 'queued');
  finishSuccess(fx.store, 'logs');
  fx.clock.set(BASE + 90_001);
  const stale = fx.store.request(['logs'], { force: true }).groups[0];
  assert.equal(stale.state, 'disabled');
  assert.equal(stale.request_id, 1);
  fx.store.heartbeat(['logs']);
  fx.heartbeatAt(BASE + 100_000);
  assert.equal(fx.store.request(['logs'], { force: true }).groups[0].state, 'queued');
  fx.store.register([]);
  assert.deepEqual(fx.store.pending(['logs']), []);
  assert.equal(fx.group().state, 'disabled');
  assert.equal(fx.group().request_id, fx.group().completed_id, '关闭时不遗留等待任务');
});

test('两个连接共享正在执行的其他 PID，拒绝冒领和越权完成', (t) => {
  const fx = fixture(t);
  const peer = fx.connect(202);
  fx.store.request(['logs']);
  const owner = fx.store.claim('logs');
  assert.equal(peer.read(['logs']).groups[0].state, 'running');
  assert.equal(peer.claim('logs'), null, '其他活 PID 占用时不得重复执行');
  assert.equal(peer.request(['logs'], { force: true }).groups[0].request_id, owner.id);
  assert.throws(() => peer.finish('logs', owner), /归属/);
  assert.equal(fx.group().state, 'running');
  fx.store.finish('logs', owner);
  assert.equal(peer.read(['logs']).groups[0].completed_id, owner.id);
  assert.throws(() => fx.store.finish('logs', owner), /归属/, '重复完成不能覆盖状态');
});

test('死 PID 的任务可被新进程重试，旧执行者的迟到结果不能覆盖新执行者', (t) => {
  const fx = fixture(t);
  finishSuccess(fx.store, 'logs');
  fx.heartbeatAt(BASE + 60_000);
  fx.store.request(['logs']);
  const abandoned = fx.store.claim('logs');
  fx.alive.delete(101);
  const peer = fx.connect(202);
  const queued = peer.request(['logs'], { force: true }).groups[0];
  assert.equal(queued.state, 'queued');
  assert.equal(queued.last_success_at, BASE);
  assert.ok(queued.request_id > abandoned.id);
  const replacement = peer.claim('logs');
  assert.ok(replacement);
  assert.throws(() => fx.store.finish('logs', abandoned), /归属/);
  assert.equal(peer.read(['logs']).groups[0].state, 'running');
  peer.finish('logs', replacement);
  assert.equal(fx.group().last_success_at, BASE + 60_000);
  assert.equal(fx.group().completed_id, replacement.id);
});

test('采集进程重新注册会恢复死 PID，保留可见错误并允许重试', (t) => {
  const fx = fixture(t);
  fx.store.request(['logs']);
  fx.store.claim('logs');
  fx.alive.delete(101);
  const peer = fx.connect(202);
  peer.register(['logs']);
  const recovered = peer.read(['logs']).groups[0];
  assert.equal(recovered.state, 'error');
  assert.match(recovered.error, /退出|重试/);
  assert.equal(recovered.last_success_at, null);
  assert.equal(peer.request(['logs']).groups[0].state, 'queued');
});

test('并行 SQLite 连接争抢同一请求，仅一个 PID 原子认领成功', async (t) => {
  const fx = fixture(t);
  fx.store.request(['logs']);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openDashboardDb } = await import(workerData.dashboardModule);
      const { createCollectionRefreshStore } = await import(workerData.collectionModule);
      const db = openDashboardDb(workerData.file);
      try {
        const store = createCollectionRefreshStore(db, {
          now: () => workerData.now, isAlive: () => true, pid: workerData.pid,
        });
        parentPort.postMessage({ type: 'ready' });
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        parentPort.postMessage({ type: 'claimed', pid: workerData.pid, attempt: store.claim('logs') });
      } finally { db.close(); }
    })().catch((error) => { throw error; });
  `;
  try {
    const participants = [301, 302].map((pid) => {
      const ready = deferred();
      let resultResolve;
      let resultReject;
      const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      const worker = new Worker(workerCode, {
        eval: true,
        workerData: {
          file: fx.file, now: BASE, pid, gate: gate.buffer,
          dashboardModule: new URL('../store/dashboard.mjs', import.meta.url).href,
          collectionModule: new URL('../lib/collection-refresh.mjs', import.meta.url).href,
        },
      });
      workers.push(worker);
      worker.on('message', (message) => {
        if (message.type === 'ready') ready.resolve();
        else if (message.type === 'claimed') resultResolve(message);
      });
      worker.on('error', (error) => { ready.resolve(); resultReject(error); });
      worker.on('exit', (code) => {
        ready.resolve();
        resultReject(new Error(`认领线程退出，未返回结果：${code}`));
      });
      return { ready: ready.promise, result };
    });
    const results = Promise.all(participants.map((entry) => entry.result));
    await Promise.all(participants.map((entry) => entry.ready));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const outcomes = await results;
    const winners = outcomes.filter((entry) => entry.attempt !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].attempt.id, 1);
    assert.equal(fx.db.prepare('SELECT running_pid FROM collection_refresh WHERE resource = ?').get('logs').running_pid, winners[0].pid);
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

test('空增量仍算成功，以本轮开始时间更新成功时间', async (t) => {
  const fx = fixture(t);
  const empty = { missing: false, scanned: 0, inserted: 0, skipped: 0 };
  let calls = 0;
  const collector = fx.collector({ logs: async () => { calls += 1; return empty; } });
  assert.deepEqual(await collector.run('logs'), empty);
  assert.equal(fx.group().last_success_at, BASE);
  fx.heartbeatAt(BASE + 60_000);
  fx.store.request(['logs']);
  const startedAt = fx.clock.now();
  await collector.run('logs');
  assert.equal(calls, 2);
  assert.equal(fx.group().last_success_at, startedAt);
  assert.equal(fx.group().error, null);
});

for (const result of [{ status: 'failed' }, { status: 'partial' }, { missing: true }, { status: 'ok', missing: true }]) {
  test(`${JSON.stringify(result)}：返回不完整结果不重置成功时间，并暴露失败`, async (t) => {
    const fx = fixture(t);
    finishSuccess(fx.store, 'logs');
    fx.heartbeatAt(BASE + 60_000);
    const queued = fx.store.request(['logs']).groups[0];
    const collector = fx.collector({ logs: async () => result });
    assert.deepEqual(await collector.run('logs'), result);
    assert.equal(fx.group().last_success_at, BASE);
    assert.equal(fx.group().last_attempt_at, BASE + 60_000);
    assert.equal(fx.group().completed_id, queued.request_id);
    assert.equal(fx.group().state, 'cooldown');
    assert.ok(fx.group().error, '不能将部分采集伪装成完整成功');
  });
}

test('定时 run 与排队 drain 共用同一轮任务和结果，两个触发顺序均不重入', async (t) => {
  const fx = fixture(t);
  let calls = 0;
  let gate = fx.hold();
  const collector = fx.collector({ logs: async () => { calls += 1; return gate.promise; } });
  fx.store.request(['logs']);
  const scheduled = collector.run('logs');
  collector.drain();
  const joined = collector.run('logs');
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(fx.group().state, 'running');
  gate.resolve({ status: 'ok', inserted: 0 });
  assert.deepEqual(await scheduled, await joined);
  assert.equal(fx.group().completed_id, 1);

  fx.heartbeatAt(BASE + 60_000);
  gate = fx.hold();
  fx.store.request(['logs']);
  collector.drain();
  const nextScheduled = collector.run('logs');
  collector.drain();
  await nextTurn();
  assert.equal(calls, 2);
  gate.resolve({ status: 'ok', inserted: 1 });
  assert.deepEqual(await nextScheduled, { status: 'ok', inserted: 1 });
  assert.equal(fx.group().completed_id, 2);
});

test('两个 collector 共用数据库锁，其他活 PID 执行时 scheduled run 返回跳过', async (t) => {
  const fx = fixture(t);
  const peer = fx.connect(202);
  const gate = fx.hold();
  let peerCalls = 0;
  const first = fx.collector({ logs: () => gate.promise });
  const second = fx.collector({ logs: async () => { peerCalls += 1; } }, peer);
  fx.store.request(['logs']);
  const running = first.run('logs');
  second.drain();
  assert.deepEqual(await second.run('logs'), { status: 'skipped', reason: 'already_running' });
  assert.equal(peerCalls, 0);
  gate.resolve({ status: 'ok' });
  await running;
  assert.equal(peer.read(['logs']).groups[0].completed_id, 1);
});

test('任务抛错向调用方传播，排队失败写可见脱敏错误，其他资源仍能完成', async (t) => {
  const fx = fixture(t, { registered: ['logs', 'spend'] });
  const secret = 'sk-testsecret123456';
  const failure = new Error(`源库读取失败 ${secret} authorization=private-token`);
  const collector = fx.collector({
    logs: async () => { throw failure; },
    spend: async () => ({ status: 'ok' }),
  });
  fx.store.request(['logs', 'spend']);
  collector.drain();
  await assert.rejects(collector.run('logs'), (error) => error === failure);
  await nextTurn();
  assert.equal(fx.group().last_success_at, null);
  assert.match(fx.group().error, /源库读取失败/);
  assert.doesNotMatch(fx.group().error, /sk-testsecret123456|private-token/);
  assert.equal(fx.errors.length, 1);
  assert.match(fx.errors[0], /logs.*源库读取失败/);
  assert.doesNotMatch(fx.errors[0], /sk-testsecret123456|private-token/);
  assert.equal(fx.group('spend').last_success_at, BASE);
});

test('start 只消费请求，假定时器推动轮询和心跳，stop 清理并等待在途任务', async (t) => {
  const fx = fixture(t, { registered: null });
  const gate = fx.hold();
  let calls = 0;
  const collector = fx.collector({ logs: async () => { calls += 1; return gate.promise; } }).start();
  assert.equal(calls, 0, '启动不能绕过按需条件自行采集');
  assert.equal(fx.clock.intervals.size, 2);
  await fx.clock.advance(90_001);
  assert.notEqual(fx.group().state, 'disabled', '心跳定时器保持采集器可用');
  fx.store.request(['logs']);
  await fx.clock.advance(998);
  assert.equal(calls, 0);
  await fx.clock.advance(1);
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = collector.stop().then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false, 'stop 等待真实任务结束');
  assert.equal(fx.clock.intervals.size, 0);
  gate.resolve({ status: 'ok' });
  await stopping;
  fx.heartbeatAt(fx.clock.now() + 60_000);
  fx.store.request(['logs']);
  collector.drain();
  await fx.clock.advance(1_000);
  assert.equal(calls, 1, '停止后不再消费排队请求');
});

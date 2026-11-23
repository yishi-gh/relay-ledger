/**
 * 双通道 API 查询执行器（fast / heavy）：
 * - fast 通道：/api/meta、/api/quality、/api/routes、/api/errors，永不被重聚合阻塞；
 * - heavy 通道：其余统计与明细聚合接口；
 * - 相同 cache key 的并发请求合并（in-flight 去重），避免重复查库；
 * - 尚未开始执行的排队任务，若所有等待客户端都已断开则直接跳过，防止重试雪崩。
 */

import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./api-worker.mjs', import.meta.url);

export const FAST_API_ROUTES = new Set([
  '/api/meta',
  '/api/quality',
  '/api/routes',
  '/api/errors',
]);

function reviveError(errorName, message) {
  if (errorName === 'RangeError') return new RangeError(message);
  if (errorName === 'TypeError') return new TypeError(message);
  const err = new Error(message);
  if (errorName && typeof errorName === 'string') err.name = errorName;
  return err;
}

function createAbortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

function createLane(workerData) {
  let worker = null;
  let closed = false;
  let nextId = 1;
  let active = null;
  const queue = [];
  const inFlightByKey = new Map();

  function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(WORKER_URL, { workerData });
    w.on('message', (msg) => {
      if (!msg || typeof msg !== 'object' || msg.type === 'shutdown_ok') return;
      if (!active || active.id !== msg.id) return;
      const job = active;
      active = null;
      inFlightByKey.delete(job.key);
      if (msg.ok) {
        const value = msg.notFound ? null : msg.payload;
        for (const waiter of job.waiters) waiter.resolve(value);
      } else {
        const err = reviveError(msg.errorName, msg.message);
        for (const waiter of job.waiters) waiter.reject(err);
      }
      pump();
    });
    w.on('error', (err) => {
      if (worker === w) worker = null;
      failActive(err);
      pump();
    });
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (!closed) {
        failActive(new Error(`查询工作线程异常退出（code=${code}）`));
        pump();
      }
    });
    worker = w;
    return w;
  }

  function failActive(err) {
    if (!active) return;
    const job = active;
    active = null;
    inFlightByKey.delete(job.key);
    for (const waiter of job.waiters) waiter.reject(err);
  }

  function pump() {
    if (closed || active) return;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next.waiters.size === 0) {
        inFlightByKey.delete(next.key);
        continue;
      }
      active = next;
      try {
        const w = ensureWorker();
        w.postMessage({ id: next.id, pathname: next.pathname, search: next.search });
      } catch (err) {
        failActive(err);
        continue;
      }
      return;
    }
  }

  function run({ key, pathname, search, signal = null }) {
    if (closed) return Promise.reject(new Error('查询服务已关闭'));
    if (signal?.aborted) return Promise.reject(createAbortError());

    let job = inFlightByKey.get(key);
    if (!job) {
      job = {
        id: nextId++,
        key,
        pathname,
        search,
        waiters: new Set(),
      };
      inFlightByKey.set(key, job);
      queue.push(job);
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const waiter = {
        resolve(value) {
          cleanup();
          resolve(value);
        },
        reject(err) {
          cleanup();
          reject(err);
        },
      };
      const onAbort = () => {
        job.waiters.delete(waiter);
        // 仍在排队且无人等待时直接取消，避免断开的请求堆积
        if (job.waiters.size === 0 && active !== job) {
          inFlightByKey.delete(job.key);
        }
        waiter.reject(createAbortError());
      };
      job.waiters.add(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pump();
    });
  }

  async function close() {
    closed = true;
    const err = new Error('查询服务正在关闭');
    failActive(err);
    while (queue.length > 0) {
      const job = queue.shift();
      inFlightByKey.delete(job.key);
      for (const waiter of job.waiters) waiter.reject(err);
    }
    if (worker) {
      const w = worker;
      worker = null;
      try {
        w.postMessage({ type: 'shutdown' });
      } catch {
        // 忽略
      }
      await w.terminate();
    }
  }

  return { run, close };
}

export function createApiQueryRunner(workerData) {
  const fastLane = createLane(workerData);
  const heavyLane = createLane(workerData);

  return {
    run({ key, pathname, search, signal = null }) {
      const lane = FAST_API_ROUTES.has(pathname) ? fastLane : heavyLane;
      return lane.run({ key, pathname, search, signal });
    },
    async close() {
      await Promise.allSettled([fastLane.close(), heavyLane.close()]);
    },
  };
}

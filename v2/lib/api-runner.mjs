/**
 * 双通道 API 查询执行器（fast / heavy）：
 * - fast 通道：/api/meta、/api/quality、/api/routes、/api/errors，永不被重聚合阻塞；
 * - heavy 通道：其余统计与明细聚合接口；
 * - 相同 cache key 的并发请求合并（in-flight 去重），避免重复查库；
 * - 尚未开始执行的排队任务，若所有等待客户端都已断开则直接跳过，防止重试雪崩。
 */

import os from 'node:os';
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

function createLane(workerData, concurrency = 1) {
  const maxSlots = Math.max(1, concurrency);
  const slots = Array.from({ length: maxSlots }, () => ({ worker: null, active: null }));
  let closed = false;
  let nextId = 1;
  const queue = [];
  const inFlightByKey = new Map();

  function failSlot(slot, err) {
    if (!slot.active) return;
    const job = slot.active;
    slot.active = null;
    inFlightByKey.delete(job.key);
    for (const waiter of job.waiters) waiter.reject(err);
  }

  function ensureWorker(slot) {
    if (slot.worker) return slot.worker;
    const w = new Worker(WORKER_URL, { workerData });
    w.on('message', (msg) => {
      if (!msg || typeof msg !== 'object' || msg.type === 'shutdown_ok') return;
      if (!slot.active || slot.active.id !== msg.id) return;
      const job = slot.active;
      slot.active = null;
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
      if (slot.worker === w) slot.worker = null;
      failSlot(slot, err);
      pump();
    });
    w.on('exit', (code) => {
      if (slot.worker === w) slot.worker = null;
      if (!closed) {
        failSlot(slot, new Error(`查询工作线程异常退出（code=${code}）`));
        pump();
      }
    });
    slot.worker = w;
    return w;
  }

  function pump() {
    if (closed) return;
    for (const slot of slots) {
      if (slot.active) continue;
      while (queue.length > 0) {
        const next = queue.shift();
        if (next.waiters.size === 0) {
          inFlightByKey.delete(next.key);
          continue;
        }
        slot.active = next;
        try {
          const w = ensureWorker(slot);
          w.postMessage({ id: next.id, pathname: next.pathname, search: next.search });
        } catch (err) {
          failSlot(slot, err);
          continue;
        }
        break;
      }
    }
  }

  function isJobActive(job) {
    return slots.some((slot) => slot.active === job);
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
        if (job.waiters.size === 0 && !isJobActive(job)) {
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
    for (const slot of slots) failSlot(slot, err);
    while (queue.length > 0) {
      const job = queue.shift();
      inFlightByKey.delete(job.key);
      for (const waiter of job.waiters) waiter.reject(err);
    }
    await Promise.allSettled(slots.map(async (slot) => {
      if (!slot.worker) return;
      const w = slot.worker;
      slot.worker = null;
      try {
        w.postMessage({ type: 'shutdown' });
      } catch {
        // 忽略
      }
      await w.terminate();
    }));
  }

  return { run, close };
}

export function createApiQueryRunner(workerData, { heavyConcurrency } = {}) {
  const defaultHeavy = Math.max(2, Math.min(3, os.availableParallelism?.() ?? 2));
  const fastLane = createLane(workerData, 1);
  const heavyLane = createLane(workerData, heavyConcurrency ?? defaultHeavy);

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

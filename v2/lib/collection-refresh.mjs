/** 按需采集的共享状态与执行入口；HTTP 进程入队，常驻采集进程消费。 */
export const COLLECTION_RESOURCES = Object.freeze({
  logs: { ttl: 60_000, job: 'collect-site-logs', label: '业务日志' },
  errors: { ttl: 60_000, job: 'upstream-errors', label: '上游错误' },
  httpErrors: { ttl: 60_000, job: 'http-errors', label: '入口错误' },
  spend: { ttl: 300_000, job: 'collect-spend', label: '余额与充值' },
  routes: { ttl: 60_000, job: 'channel-state', label: '渠道配置' },
});

const PAGE_RESOURCES = Object.freeze({
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
});

const CACHE_RESOURCES = {
  '/api/meta': ['logs'], '/api/trend': ['logs'], '/api/models': ['logs'],
  '/api/users': ['logs'], '/api/rows': ['logs'], '/api/errors': ['httpErrors'],
  '/api/status': ['logs', 'errors', 'routes'], '/api/routes': ['logs', 'errors', 'routes'],
  '/api/channels': ['logs', 'routes'], '/api/groups': ['logs', 'routes'],
  '/api/overview': ['logs', 'spend', 'routes'], '/api/profit': ['logs', 'spend', 'routes'],
  '/api/upstreams': ['logs', 'spend', 'routes'], '/api/capital': ['logs', 'spend', 'routes'],
};

export function resourcesForView(view) {
  if (!Object.hasOwn(PAGE_RESOURCES, view)) throw new RangeError('未知的看板页面');
  return PAGE_RESOURCES[view];
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function cleanError(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')
    .replace(/(cookie|authorization|refresh_token|token|pat|bearer)\s*[=: ]\s*\S+/gi, '$1=***')
    .slice(0, 300);
}

function incompleteError(resource) {
  return `${COLLECTION_RESOURCES[resource].label}采集未完整成功，请查看数据质量`;
}

function spendIssue(account) {
  if (account.balance?.status === 'unconfigured') return '未配置余额来源';
  if (account.balance?.reason === 'network_error') return '网络错误';
  if (account.balance?.status !== 'ok') return '余额采集未成功';
  if (account.ledger?.reason === 'exception') return '账本采集异常';
  if (account.balance_source === 'session' && ['unavailable', 'partial'].includes(account.credits?.status)) {
    return '充值记录未完整采到';
  }
  return null;
}

export function createCollectionRefreshStore(db, { now = Date.now, isAlive = processAlive, pid = process.pid } = {}) {
  const rowOf = (resource) => db.prepare('SELECT * FROM collection_refresh WHERE resource = ?').get(resource);
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function ensure(resource) {
    if (!Object.hasOwn(COLLECTION_RESOURCES, resource)) throw new RangeError('未知的采集资源');
    db.prepare('INSERT OR IGNORE INTO collection_refresh (resource) VALUES (?)').run(resource);
  }
  function recover(resource) {
    const row = rowOf(resource);
    if (row?.running_pid && !isAlive(row.running_pid)) {
      db.prepare(`UPDATE collection_refresh SET running_pid = NULL, completed_id = request_id,
        error = '上次采集进程已退出，请重试', retry_at = 0 WHERE resource = ?`).run(resource);
    }
  }
  function partialSpend(row) {
    if (row?.error !== incompleteError('spend') || row.last_attempt_at == null) return null;
    // 复用采集器已写入的本轮记录，也能识别升级前的部分成功。
    const run = db.prepare(`SELECT status, detail FROM job_runs
      WHERE job = 'collect-spend' AND started_at >= ? ORDER BY id DESC LIMIT 1`).get(row.last_attempt_at);
    if (run?.status !== 'partial') return null;
    let accounts;
    try { accounts = JSON.parse(run.detail)?.accounts; }
    catch { return null; }
    if (!Array.isArray(accounts)) return null;
    const updated_accounts = [];
    const issues = [];
    for (const account of accounts) {
      if (!account) continue;
      const name = [account.name, account.id].find((value) => typeof value === 'string' && value) ?? '未知账户';
      if (account.written?.balance === true) updated_accounts.push(name);
      const reason = spendIssue(account);
      if (reason) issues.push({ name, reason });
    }
    return updated_accounts.length > 0 ? { updated_accounts, issues } : null;
  }
  function group(resource) {
    const row = rowOf(resource);
    let spendResult = null;
    let state = 'fresh';
    if (!row?.enabled || now() - (row.heartbeat_at ?? 0) > 90_000) state = 'disabled';
    else if (row.running_pid) state = 'running';
    else if (row.request_id > row.completed_id) state = 'queued';
    else if (resource === 'spend' && (spendResult = partialSpend(row))) state = 'partial';
    else if (row.retry_at > now()) state = 'cooldown';
    else if (row.error) state = 'error';
    return {
      resource, request_id: row?.request_id ?? 0, completed_id: row?.completed_id ?? 0, state,
      last_success_at: row?.last_success_at ?? null, last_attempt_at: row?.last_attempt_at ?? null,
      retry_at: row?.retry_at || null,
      error: state === 'disabled' ? `${COLLECTION_RESOURCES[resource].label}采集未启用或采集进程未响应` : spendResult ? null : row?.error ?? null,
      ...(spendResult ? { spend_result: spendResult } : {}),
    };
  }
  function read(resources) {
    return { groups: resources.map(group), revision: version() };
  }
  function version(pathname) {
    const resources = CACHE_RESOURCES[pathname] ?? Object.keys(COLLECTION_RESOURCES);
    return resources.map((resource) => {
      const row = rowOf(resource);
      return `${resource}:${row?.completed_id ?? 0}:${row?.last_success_at ?? 0}`;
    }).join('|');
  }
  function request(resources, { force = false } = {}) {
    return transaction(() => {
      for (const resource of resources) {
        ensure(resource);
        recover(resource);
        const row = rowOf(resource);
        if (row.running_pid || row.request_id > row.completed_id) continue;
        if (!row.enabled || now() - (row.heartbeat_at ?? 0) > 90_000) continue;
        if (row.retry_at > now()) continue;
        if (!force) {
          const ttl = COLLECTION_RESOURCES[resource].ttl;
          if (!row.error && row.last_success_at != null && now() - row.last_success_at < ttl) continue;
          if (resource === 'spend' && row.last_attempt_at != null && now() - row.last_attempt_at < ttl && partialSpend(row)) continue;
        }
        db.prepare('UPDATE collection_refresh SET request_id = request_id + 1, error = NULL WHERE resource = ?').run(resource);
      }
      return read(resources);
    });
  }
  function register(resources) {
    transaction(() => {
      for (const resource of Object.keys(COLLECTION_RESOURCES)) {
        ensure(resource);
        recover(resource);
        const enabled = resources.includes(resource);
        // 升级前已有采集记录时沿用成功时间，不将“注册”算成一次采集。
        const previous = db.prepare(`SELECT started_at, finished_at FROM job_runs
          WHERE job = ? AND status = 'ok' ORDER BY finished_at DESC LIMIT 1`).get(COLLECTION_RESOURCES[resource].job);
        db.prepare(`UPDATE collection_refresh SET enabled = ?, heartbeat_at = ?,
          last_success_at = COALESCE(last_success_at, ?),
          completed_id = CASE WHEN ? = 0 AND running_pid IS NULL THEN request_id ELSE completed_id END
          WHERE resource = ?`).run(Number(enabled), now(), previous?.started_at ?? previous?.finished_at ?? null, Number(enabled), resource);
      }
    });
  }
  function heartbeat(resources) {
    const statement = db.prepare('UPDATE collection_refresh SET heartbeat_at = ? WHERE resource = ? AND enabled = 1');
    for (const resource of resources) statement.run(now(), resource);
  }
  function claim(resource) {
    return transaction(() => {
      ensure(resource);
      recover(resource);
      const row = rowOf(resource);
      if (row.running_pid) return null;
      const id = row.request_id > row.completed_id ? row.request_id : row.request_id + 1;
      db.prepare(`UPDATE collection_refresh SET request_id = ?, running_pid = ?,
        last_attempt_at = ?, error = NULL WHERE resource = ?`).run(id, pid, now(), resource);
      return { id, startedAt: now() };
    });
  }
  function finish(resource, attempt, error = null) {
    transaction(() => {
      const row = rowOf(resource);
      if (row.running_pid !== pid || row.request_id !== attempt.id) throw new Error('采集任务归属已变化');
      const failures = error ? row.failures + 1 : 0;
      const cooldown = error ? Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)) : resource === 'spend' ? 30_000 : 10_000;
      db.prepare(`UPDATE collection_refresh SET completed_id = ?, running_pid = NULL,
        last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
        error = ?, failures = ?, retry_at = ? WHERE resource = ?`)
        .run(attempt.id, error, attempt.startedAt, error, failures, now() + cooldown, resource);
    });
  }
  function pending(resources) {
    return resources.filter((resource) => {
      const row = rowOf(resource);
      return row?.enabled && !row.running_pid && row.request_id > row.completed_id;
    });
  }
  function unregister(resources) {
    transaction(() => {
      for (const resource of resources) {
        db.prepare(`UPDATE collection_refresh SET enabled = 0,
          completed_id = CASE WHEN running_pid IS NULL THEN request_id ELSE completed_id END
          WHERE resource = ?`).run(resource);
      }
    });
  }
  return { read, request, version, register, heartbeat, claim, finish, pending, unregister };
}

/** 定时任务和面板任务共用这层入口；数据库原子认领也阻止另一个进程重复执行。 */
export function createOnDemandCollector({ store, tasks, resources, timer = globalThis, logError = console.error }) {
  const inFlight = new Map();
  let pollTimer = null;
  let heartbeatTimer = null;
  let stopped = false;
  async function run(resource) {
    if (inFlight.has(resource)) return inFlight.get(resource);
    const attempt = store.claim(resource);
    if (!attempt) return { status: 'skipped', reason: 'already_running' };
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await tasks[resource]();
        const failed = result?.missing || (result?.status && result.status !== 'ok');
        store.finish(resource, attempt, failed ? incompleteError(resource) : null);
        return result;
      } catch (error) {
        store.finish(resource, attempt, cleanError(error.message ?? error));
        throw error;
      } finally { inFlight.delete(resource); }
    });
    inFlight.set(resource, promise);
    return promise;
  }
  function drain() {
    if (stopped) return;
    try {
      for (const resource of store.pending(resources)) {
        void run(resource).catch((error) => logError(`[按需采集] ${resource}: ${cleanError(error.message ?? error)}`));
      }
    } catch (error) {
      logError(`[按需采集] 读取队列失败: ${cleanError(error.message ?? error)}`);
    }
  }
  return {
    run,
    start() {
      if (pollTimer !== null) return this;
      stopped = false;
      store.register(resources);
      pollTimer = timer.setInterval(drain, 1000);
      heartbeatTimer = timer.setInterval(() => {
        try { store.heartbeat(resources); }
        catch (error) { logError(`[按需采集] 心跳写入失败: ${cleanError(error.message ?? error)}`); }
      }, 30_000);
      drain();
      return this;
    },
    async stop() {
      stopped = true;
      timer.clearInterval(pollTimer);
      timer.clearInterval(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
      await Promise.allSettled(inFlight.values());
      store.unregister(resources);
    },
    drain,
  };
}

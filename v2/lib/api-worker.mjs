/**
 * 只读 API 查询工作线程：把同步 SQLite 聚合从 HTTP 主线程挪走，
 * 避免慢查询阻塞 /api/refresh、/api/meta、静态资源与缓存命中响应。
 */

import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { createApi } from './api.mjs';
import { createRuntimeSettingsStore } from './runtime-settings.mjs';
import { API_ROUTES, openSourceDb } from '../server.mjs';

const {
  sourcePath,
  dashboardPath,
  config,
  siteName,
  siteDisplayName,
  sourceLabel,
  siteBaseUrl,
  settingsDataDir,
  collectionDefaults,
} = workerData;

const source = openSourceDb(sourcePath);
const dashboard = new DatabaseSync(dashboardPath, { readOnly: true });
dashboard.exec('PRAGMA busy_timeout = 3000');

const settingsStore = createRuntimeSettingsStore({
  dataDir: settingsDataDir,
  collectionDefaults,
});

const api = createApi({
  source,
  dashboard,
  config,
  siteName,
  sourceLabel,
  getHealthSettings: () => settingsStore.read().settings.health,
  siteBaseUrl,
});

function executeRoute(pathname, search) {
  const url = new URL(`${pathname}${search || ''}`, 'http://localhost');
  if (pathname === '/api/meta') {
    return {
      ...api.meta(),
      site_name: siteDisplayName,
      base_url: siteBaseUrl,
    };
  }
  const handler = API_ROUTES[pathname];
  if (!handler) return null;
  return handler(api, url);
}

function closeDbs() {
  try {
    source.close();
  } catch {
    // 忽略关闭异常
  }
  try {
    dashboard.close();
  } catch {
    // 忽略关闭异常
  }
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    closeDbs();
    parentPort.postMessage({ type: 'shutdown_ok' });
    return;
  }
  const { id, pathname, search } = msg;
  try {
    const result = executeRoute(pathname, search);
    if (result === null) {
      parentPort.postMessage({ id, ok: true, notFound: true });
      return;
    }
    parentPort.postMessage({ id, ok: true, payload: JSON.stringify(result) });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      errorName: err?.name ?? 'Error',
      message: err?.message ?? String(err),
    });
  }
});

/**
 * 从 NewAPI 站点库的 channels 表取中转站渠道 key，并用它读余额。
 *
 * - relay db 只读打开；文件不存在（本地开发）返回 null，由调用方退回会话采集
 * - 余额端点：GET {scheme}://{host}/v1/usage，Authorization: Bearer <key>
 * - key 只进请求头，绝不写进返回值、日志或错误信息
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const USAGE_PATH = '/v1/usage';

/** 只读打开 relay 库；文件不存在或无法打开时返回 null */
export function openRelayDb(file) {
  if (typeof file !== 'string' || file.trim() === '') return null;
  try {
    if (!fs.existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

/** 取渠道凭据；渠道不存在或没有 key 时返回 null */
export function getChannelCredential(db, channelId) {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT key, base_url FROM channels WHERE id = ?').get(channelId);
    if (!row || typeof row.key !== 'string' || row.key.trim() === '') return null;
    return {
      key: row.key,
      base_url: typeof row.base_url === 'string' && row.base_url.trim() ? row.base_url : null,
    };
  } catch {
    return null;
  }
}

/** 把渠道 base_url 规整成 {scheme}://{host}；没有 scheme 时补 https:// */
function normalizeBase(baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) throw new Error('missing base_url');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withScheme).origin;
}

function toBalance(body) {
  const candidates = [
    body?.balance,
    body?.data?.balance,
    body?.remaining,
    body?.data?.remaining,
  ];
  for (const value of candidates) {
    const n = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 用渠道 key 读余额。
 * @returns {Promise<{ok: true, balance: number, unit: 'USD', raw: {balance: number}}
 *   | {ok: false, reason: string}>}
 */
export async function fetchUsageByKey(baseUrl, key, { timeoutMs = 15000, fetchImpl } = {}) {
  const token = typeof key === 'string' ? key.trim() : '';
  if (!token) return { ok: false, reason: 'missing_key' };

  let origin;
  try {
    origin = normalizeBase(baseUrl);
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  try {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const response = await doFetch(`${origin}${USAGE_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };

    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'unexpected_response' };
    }
    const balance = toBalance(body);
    if (balance === null) return { ok: false, reason: 'unexpected_response' };
    return { ok: true, balance, unit: 'USD', raw: { balance } };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}
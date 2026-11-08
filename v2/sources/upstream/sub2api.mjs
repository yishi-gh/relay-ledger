/**
 * sub2api 上游适配器。
 *
 * - 余额：GET /api/v1/auth/me，取 balance（USD）；兼容 balanceUsd/quota 旧字段。
 * - 上报消费：GET /api/v1/usage/stats?period=today 的 total_actual_cost（USD）。
 * - 充值/赠额：sub2api 没有对应接口，明确标 unsupported，不伪造 0。
 *
 * 只把 token 放进请求头；返回值与错误里都不含 token。
 */

import { errorResult, failed, result, toNum, unwrap } from './common.mjs';
import { fetchUsageByKey } from './relay-key.mjs';
import { dayKey } from '../../lib/time.mjs';

function endpoint(account, key, fallback) {
  const path = account?.endpoints?.[key];
  return new URL(typeof path === 'string' && path ? path : fallback, account.base_url).toString();
}

/**
 * 用中转站渠道 key 读余额（GET /v1/usage），返回统一结果形状。
 * 失败只带短 reason，不含 key。
 */
export async function fetchBalanceByKey({ baseUrl, key, timeoutMs, fetchImpl } = {}) {
  const hit = await fetchUsageByKey(baseUrl, key, { timeoutMs, fetchImpl });
  if (!hit.ok) return failed(hit.reason);
  return result({ value: hit.balance, unit: hit.unit, raw: hit.raw });
}

export function createSub2ApiSource({ account, client, headers = {} } = {}) {

  async function fetchBalance() {
    try {
      const json = await client.getJson(endpoint(account, 'balance', '/api/v1/auth/me'), { headers });
      const data = unwrap(json);
      const configured = account?.balance_field ? toNum(data?.[account.balance_field]) : null;
      const balance = toNum(data?.balance ?? data?.balanceUsd ?? data?.balance_usd);
      const quota = toNum(data?.quota);
      // 累计充值总额：增量即真实充值，不必再用「余额上涨」推断
      const recharged = toNum(data?.total_recharged);
      if (configured !== null) {
        return result({ value: configured, unit: 'USD', raw: { value: configured, unit: 'USD' }, recharged });
      }
      if (balance !== null) {
        return result({ value: balance, unit: 'USD', raw: { value: balance, unit: 'USD' }, recharged });
      }
      if (quota !== null) {
        return result({ value: quota, unit: 'USD', raw: { value: quota, unit: 'USD' }, recharged });
      }
      return failed('missing_field:balance');
    } catch (err) {
      return errorResult(err);
    }
  }

  async function fetchReportedSpend({ from, to } = {}) {
    try {
      const url = new URL(endpoint(account, 'usage', '/api/v1/usage/stats?period=today'));
      if (Number.isFinite(from) && Number.isFinite(to)) {
        url.searchParams.set('start_date', dayKey(from));
        url.searchParams.set('end_date', dayKey(to));
        url.searchParams.delete('period');
      }
      const json = await client.getJson(url.toString(), { headers });
      const data = unwrap(json);
      const cost = toNum(data?.total_actual_cost ?? data?.totalActualCost);
      if (cost === null) return failed('missing_field:total_actual_cost');
      return result({ value: cost, unit: 'USD', raw: { value: cost, unit: 'USD' } });
    } catch (err) {
      return errorResult(err);
    }
  }

  async function fetchCredits() {
    return result({ status: 'unsupported', reason: 'credits_unsupported', unit: 'USD' });
  }

  return { kind: 'sub2api', fetchBalance, fetchCredits, fetchReportedSpend };
}

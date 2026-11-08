/**
 * New API 上游适配器。
 *
 * - 余额：GET /api/user/self 的 data.quota（New API 内部单位），按账户 quota_per_unit 折算 USD，
 *   原始值放 raw，绝不把 quota 直接当 USD。
 * - 充值/赠额：GET /api/log/self?type=1（充值）与 type=4（系统/赠额）分页，窗口内求和。
 *   全部页取完才是 complete；否则 partial，未知与零入账严格区分。
 * - 上报消费：GET /api/log/self/stat 的 quota（窗口内），按 quota_per_unit 折算 USD。
 *
 * 只把 token 放进请求头；返回值与错误里都不含 token。
 */

import { errorResult, eventTimeMs, extractLogItems, failed, isAuthRejection, result, toNum, unwrap } from './common.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const CREDIT_TYPES = [
  { type: 1, kind: 'topup' },
  { type: 4, kind: 'gift' },
];

function endpoint(account, key, fallback) {
  const path = account?.endpoints?.[key];
  return new URL(typeof path === 'string' && path ? path : fallback, account.base_url).toString();
}

export function createNewApiSource({ account, client, headers = {}, quotaPerUnit = null, expectedUserId = null } = {}) {
  const unitQuota = toNum(account?.quota_per_unit) ?? toNum(quotaPerUnit);
  // cookie 是站点级的，可能属于同站另一个账号：能确定期望 user id 时必须核对
  const expectUserId = toNum(expectedUserId) ?? toNum(account?.auth?.user_id);

  async function fetchBalance() {
    try {
      const json = await client.getJson(endpoint(account, 'balance', '/api/user/self'), { headers });
      // 200 + success:false「无效的令牌」也是鉴权失败，触发上层换签而不是缺字段
      if (isAuthRejection(json)) return failed('auth_failed');
      const data = unwrap(json);
      const gotUserId = toNum(data?.id ?? data?.user_id ?? data?.user?.id);
      if (expectUserId !== null && gotUserId !== null && gotUserId !== expectUserId) {
        // 拿到的余额属于别的账号，宁可不可用也不写错账户
        return failed('cookie_account_mismatch');
      }
      const quota = toNum(data?.quota);
      if (quota === null) return failed('missing_field:quota');
      if (unitQuota === null || unitQuota <= 0) return failed('missing_quota_per_unit');
      // 剩余额度 + 已用额度 = 累计充值（cc-switch 的 NewAPI 模板同口径，用 data.quota + data.used_quota）。
      // 任一字段缺失时给 null：宁可不记，也不用半截数字冒充充值总额。
      const usedQuota = toNum(data?.used_quota);
      const recharged = usedQuota === null ? null : (quota + usedQuota) / unitQuota;
      return result({
        value: quota / unitQuota,
        unit: 'USD',
        raw: { value: quota, unit: 'quota' },
        recharged,
      });
    } catch (err) {
      return errorResult(err);
    }
  }

  async function fetchCredits({ from, to } = {}) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return failed('missing_window');
    if (unitQuota === null || unitQuota <= 0) return failed('missing_quota_per_unit');

    try {
      const events = [];
      let rawQuota = 0;
      let complete = true;

      for (const { type, kind } of CREDIT_TYPES) {
        let page = 1;
        while (page <= MAX_PAGES) {
          const url = new URL(endpoint(account, 'credits', '/api/log/self'));
          url.searchParams.set('type', String(type));
          url.searchParams.set('p', String(page));
          url.searchParams.set('page_size', String(PAGE_SIZE));
          const json = await client.getJson(url.toString(), { headers });
          if (isAuthRejection(json)) return failed('auth_failed');
          const { items, total } = extractLogItems(json);

          for (const item of items) {
            const tMs = eventTimeMs(item);
            const quota = toNum(item?.quota);
            if (tMs === null || quota === null) {
              // 字段缺失时不能当作没有这笔入账
              complete = false;
              continue;
            }
            if (tMs < from || tMs > to) continue;
            rawQuota += quota;
            events.push({
              t_ms: tMs,
              amount: quota / unitQuota,
              kind,
              raw_quota: quota,
              note: typeof item?.content === 'string' ? item.content.slice(0, 200) : null,
            });
          }

          if (items.length < PAGE_SIZE) break;
          if (total !== null && page * PAGE_SIZE >= total) break;
          if (page === MAX_PAGES) complete = false;
          page += 1;
        }
      }

      return result({
        value: rawQuota / unitQuota,
        unit: 'USD',
        status: complete ? 'ok' : 'partial',
        reason: complete ? null : 'credits_incomplete',
        raw: { value: rawQuota, unit: 'quota' },
        events,
        complete,
      });
    } catch (err) {
      return errorResult(err);
    }
  }

  async function fetchReportedSpend({ from, to } = {}) {
    try {
      const url = new URL(endpoint(account, 'usage', '/api/log/self/stat'));
      url.searchParams.set('type', '2');
      if (Number.isFinite(from)) url.searchParams.set('start_timestamp', String(Math.floor(from / 1000)));
      if (Number.isFinite(to)) url.searchParams.set('end_timestamp', String(Math.ceil(to / 1000)));
      const json = await client.getJson(url.toString(), { headers });
      if (isAuthRejection(json)) return failed('auth_failed');
      const data = unwrap(json);
      const quota = toNum(data?.quota ?? data?.total_quota ?? data?.totalQuota);
      if (quota === null) return failed('missing_field:quota');
      if (unitQuota === null || unitQuota <= 0) return failed('missing_quota_per_unit');
      return result({
        value: quota / unitQuota,
        unit: 'USD',
        raw: { value: quota, unit: 'quota' },
      });
    } catch (err) {
      return errorResult(err);
    }
  }

  return { kind: 'newapi', fetchBalance, fetchCredits, fetchReportedSpend };
}

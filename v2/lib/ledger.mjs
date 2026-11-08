/**
 * 上游账户账本口径（纯函数，无 IO）。
 *
 * 口径见 v2/CONTRACT.md：consumption = opening + credits - closing。
 * 任何缺失值一律返回 null，不用 0 顶替，也不猜测。
 *
 * 完整性判定比契约更严格：
 * - credits 只有「完整窗口」给出，`null`（未知）与 `0`（确认无入账）不同；
 * - 余额快照必须落在边界容差内，旧快照不当期初/期末余额；
 * - 区间必须是已结束的完整北京自然日；
 * - 余额上升而 credits 不足时不给负消费、不给毛利。
 */

/** 6 位小数取整，消掉 REAL 求和的浮点噪声 */
export function round6(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 原始余额差 opening + credits - closing；缺值返回 null（可为负，仅供排查展示） */
export function balanceDelta({ opening, closing, credits } = {}) {
  const o = num(opening);
  const c = num(closing);
  const cr = num(credits);
  if (o === null || c === null || cr === null) return null;
  return round6(o + cr - c);
}

/**
 * 账本完整判定，返回 { status, reason, consumption, balance_delta }。
 *
 * reason 取值：
 * - `not_configured`                 账户未配置
 * - `missing_balance`                期初或期末没有快照
 * - `missing_credits`                没有覆盖区间的完整 credits 窗口
 * - `balance_increased_without_credits` 余额上升但入账不足（原始差为负）
 * - `incomplete_day`                 区间不是已结束的完整北京自然日
 * - `stale_balance`                  期初/期末快照超出边界容差
 *
 * consumption 只在数据自洽时给值：缺失、负数、旧快照一律 null。
 */
export function evaluateLedger({
  opening,
  closing,
  credits,
  completeDay = false,
  openingFresh = true,
  closingFresh = true,
  configured = true,
} = {}) {
  const o = num(opening);
  const c = num(closing);
  const cr = num(credits);
  const delta = balanceDelta({ opening: o, closing: c, credits: cr });
  const base = { status: 'partial', reason: null, consumption: null, balance_delta: delta };

  if (!configured) return { ...base, status: 'unconfigured', reason: 'not_configured' };
  if (o === null || c === null) return { ...base, status: 'unavailable', reason: 'missing_balance' };
  if (cr === null) return { ...base, reason: 'missing_credits' };
  // 余额上升超过入账：负数不是「负消费」，是数据缺口
  if (delta < 0) return { ...base, reason: 'balance_increased_without_credits' };
  // 旧快照不是边界余额，不能据此算消费
  if (!openingFresh || !closingFresh) return { ...base, reason: 'stale_balance' };
  if (!completeDay) return { ...base, reason: 'incomplete_day', consumption: delta };
  return { ...base, status: 'complete', reason: null, consumption: delta };
}

/**
 * 区间消耗 = 期初余额 + 期间入账 - 期末余额。
 * 缺值或结果为负（余额上升超出入账）时返回 null，绝不返回负消费。
 * 完整日/新鲜度由 evaluateLedger 判定，这里只管公式本身。
 */
export function computeConsumption({ opening, closing, credits } = {}) {
  const delta = balanceDelta({ opening, closing, credits });
  return delta === null || delta < 0 ? null : delta;
}

/**
 * 毛利与毛利率。marginPct 为小数（0.2 表示 20%）。
 * revenue 缺失或为 0 时毛利率无定义（除零），两者都返回 null。
 */
export function computeMargin({ revenue, consumption } = {}) {
  const rev = num(revenue);
  const con = num(consumption);
  if (rev === null || rev === 0) {
    return { margin: null, marginPct: null, status: 'unavailable' };
  }
  if (con === null) {
    return { margin: null, marginPct: null, status: 'partial' };
  }
  const margin = round6(rev - con);
  return { margin, marginPct: round6(margin / rev), status: 'complete' };
}

/**
 * 账本状态。兼容旧调用：只传 opening/closing/credits 时视为区间未完整（partial），
 * 需要同时传 completeDay 与 fresh 标志才可能返回 complete。
 */
export function ledgerStatus(input = {}) {
  return evaluateLedger(input).status;
}

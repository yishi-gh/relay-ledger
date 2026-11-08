/**
 * 账本口径单测：正常、缺 credits（未知 vs 0）、缺余额、
 * 余额上升无充值（不给负消费）、非完整日、旧快照、除零。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  balanceDelta,
  computeConsumption,
  computeMargin,
  evaluateLedger,
  ledgerStatus,
} from '../lib/ledger.mjs';
import { DatabaseSync } from 'node:sqlite';

import { balanceToleranceMs, readBalanceAt } from '../store/dashboard.mjs';
import { initDashboardDb } from '../store/schema.mjs';

test('正常：期初 + 入账 - 期末，完整日才 complete', () => {
  const verdict = evaluateLedger({
    opening: 100,
    closing: 80,
    credits: 10,
    completeDay: true,
  });
  assert.equal(verdict.consumption, 30);
  assert.equal(verdict.status, 'complete');
  assert.equal(verdict.reason, null);
  assert.equal(computeConsumption({ opening: 100, closing: 80, credits: 10 }), 30);
  assert.equal(computeConsumption({ opening: 0.3, closing: 0.1, credits: 0.1 }), 0.3);
});

test('credits 明确为 0（零充值窗口）可以 complete', () => {
  const verdict = evaluateLedger({
    opening: 100,
    closing: 80,
    credits: 0,
    completeDay: true,
  });
  assert.equal(verdict.consumption, 20);
  assert.equal(verdict.status, 'complete');
  assert.equal(verdict.reason, null);
});

test('credits 未知：consumption 为 null，状态 partial，不当作 0', () => {
  assert.equal(computeConsumption({ opening: 100, closing: 80 }), null);
  assert.equal(computeConsumption({ opening: 100, closing: 80, credits: null }), null);
  const verdict = evaluateLedger({
    opening: 100,
    closing: 80,
    credits: null,
    completeDay: true,
  });
  assert.equal(verdict.status, 'partial');
  assert.equal(verdict.reason, 'missing_credits');
  assert.equal(verdict.consumption, null);
  assert.equal(ledgerStatus({ opening: 100, closing: 80, credits: null }), 'partial');
});

test('缺余额：返回 null，不写 0；状态 unavailable', () => {
  assert.equal(computeConsumption({ opening: null, closing: 80, credits: 5 }), null);
  assert.equal(computeConsumption({ opening: 100, closing: undefined, credits: 5 }), null);
  assert.equal(computeConsumption({}), null);
  const verdict = evaluateLedger({ opening: null, closing: 80, credits: 0, completeDay: true });
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.reason, 'missing_balance');
  assert.equal(verdict.consumption, null);
});

test('余额上升但无充值：不给负消费，也不给正毛利', () => {
  // 期初 100、期末 120、入账 0 => 原始差 -20，属于数据缺口
  assert.equal(balanceDelta({ opening: 100, closing: 120, credits: 0 }), -20);
  assert.equal(computeConsumption({ opening: 100, closing: 120, credits: 0 }), null);
  const verdict = evaluateLedger({
    opening: 100,
    closing: 120,
    credits: 0,
    completeDay: true,
  });
  assert.equal(verdict.status, 'partial');
  assert.equal(verdict.reason, 'balance_increased_without_credits');
  assert.equal(verdict.consumption, null);
  assert.equal(verdict.balance_delta, -20);
  // 入账不足以覆盖余额上升（少记 10）
  assert.equal(
    computeConsumption({ opening: 100, closing: 120, credits: 10 }),
    null,
  );
  const margin = computeMargin({ revenue: 10, consumption: verdict.consumption });
  assert.equal(margin.margin, null);
  assert.equal(margin.marginPct, null);
});

test('非完整日（默认 to=max_t）返回 partial，但可给未定稿的 consumption', () => {
  const verdict = evaluateLedger({
    opening: 100,
    closing: 80,
    credits: 10,
    completeDay: false,
  });
  assert.equal(verdict.status, 'partial');
  assert.equal(verdict.reason, 'incomplete_day');
  assert.equal(verdict.consumption, 30);
});

test('旧快照不当边界余额：partial/stale_balance，consumption 不给', () => {
  const verdict = evaluateLedger({
    opening: 100,
    closing: 80,
    credits: 10,
    completeDay: true,
    closingFresh: false,
  });
  assert.equal(verdict.status, 'partial');
  assert.equal(verdict.reason, 'stale_balance');
  assert.equal(verdict.consumption, null);
});

test('除零：收入为 0 或缺失时毛利率为 null', () => {
  assert.deepEqual(computeMargin({ revenue: 0, consumption: 5 }), {
    margin: null,
    marginPct: null,
    status: 'unavailable',
  });
  assert.deepEqual(computeMargin({ revenue: null, consumption: 5 }), {
    margin: null,
    marginPct: null,
    status: 'unavailable',
  });
  assert.deepEqual(computeMargin({ revenue: 10, consumption: null }), {
    margin: null,
    marginPct: null,
    status: 'partial',
  });
  assert.equal(computeMargin({ revenue: 0.000001, consumption: 0 }).marginPct, 1);
});

test('未配置账户优先返回 unconfigured', () => {
  const verdict = evaluateLedger({ configured: false, completeDay: true });
  assert.equal(verdict.status, 'unconfigured');
  assert.equal(verdict.reason, 'not_configured');
  assert.equal(verdict.consumption, null);
  assert.equal(ledgerStatus({ configured: false }), 'unconfigured');
});

test('粒度容差：hour=90 分钟、day=26 小时、默认仍为 10 分钟', () => {
  assert.equal(balanceToleranceMs('hour'), 90 * 60 * 1000);
  assert.equal(balanceToleranceMs('day'), 26 * 60 * 60 * 1000);
  assert.equal(balanceToleranceMs('other'), 10 * 60 * 1000);
  assert.equal(balanceToleranceMs(), 10 * 60 * 1000);
});

test('日账本用 26 小时容差：日边界前 20 小时的快照不再误报 stale', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initDashboardDb(db);
    const dayStart = Date.UTC(2026, 9, 19, 16, 0, 0); // 2026-10-20 00:00 +08
    db.prepare(
      `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, source, recorded_at)
       VALUES ('acc', ?, '2026-10-19', 100, 'USD', 'test', ?)`,
    ).run(dayStart - 20 * 3600_000, dayStart - 20 * 3600_000);

    // 默认 10 分钟：旧值不当边界余额
    const strict = readBalanceAt(db, 'acc', dayStart);
    assert.equal(strict.fresh, false);

    // 日粒度 26 小时：同一快照可用
    const day = readBalanceAt(db, 'acc', dayStart, balanceToleranceMs('day'));
    assert.equal(day.fresh, true);

    const verdict = evaluateLedger({
      opening: day.balance,
      closing: 80,
      credits: 10,
      completeDay: true,
      openingFresh: day.fresh,
      closingFresh: true,
    });
    assert.equal(verdict.reason, null);
    assert.equal(verdict.status, 'complete');
    assert.equal(verdict.consumption, 30);
  } finally {
    db.close();
  }
});

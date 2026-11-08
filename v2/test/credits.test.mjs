/**
 * 看板库读取层单测：credits 窗口语义、余额快照新解容差、原始值保留。
 * 用内存库，不触碰 v2/db/dashboard.db。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BALANCE_FRESH_TOLERANCE_MS,
  readBalanceAt,
  readCreditsBetween,
  upsertCreditWindow,
} from '../store/dashboard.mjs';
import { initDashboardDb } from '../store/schema.mjs';
import { evaluateLedger } from '../lib/ledger.mjs';

const DAY = 86400000;
const FROM = 1792425600000; // 2026-10-20 00:00 +08
const TO = FROM + DAY - 1;

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  initDashboardDb(db);
  return db;
}

function insertBalance(db, accountId, tMs, balance, extra = {}) {
  db.prepare(
    `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, raw_balance, raw_unit, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    tMs,
    '2026-10-20',
    balance,
    'USD',
    extra.rawBalance ?? null,
    extra.rawUnit ?? null,
    'test',
    Date.now(),
  );
}

test('无窗口无事件：credits 未知（null），不推导为 0', () => {
  const db = memoryDb();
  const info = readCreditsBetween(db, 'acc', FROM, TO);
  assert.equal(info.credits, null);
  assert.equal(info.status, 'partial');
  assert.equal(info.events, 0);
  assert.equal(
    evaluateLedger({
      opening: 100,
      closing: 80,
      credits: info.credits,
      completeDay: true,
    }).status,
    'partial',
  );
  db.close();
});

test('只有 credit_event：仅作 partial 证据，credits 仍为 null', () => {
  const db = memoryDb();
  db.prepare(
    'INSERT INTO credit_event (account_id, t_ms, amount, kind, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('acc', FROM + 3600000, 15, 'topup', 'test', Date.now());
  const info = readCreditsBetween(db, 'acc', FROM, TO);
  assert.equal(info.credits, null);
  assert.equal(info.status, 'partial');
  assert.equal(info.events, 1);
  assert.equal(info.event_total, 15);
  db.close();
});

test('覆盖区间的 complete 窗口给出明确 0 => complete', () => {
  const db = memoryDb();
  upsertCreditWindow(db, {
    accountId: 'acc',
    windowStart: FROM,
    windowEnd: TO,
    credits: 0,
    source: 'test',
  });
  insertBalance(db, 'acc', FROM, 100);
  insertBalance(db, 'acc', TO, 80);
  const info = readCreditsBetween(db, 'acc', FROM, TO);
  assert.equal(info.credits, 0);
  assert.equal(info.status, 'complete');
  const verdict = evaluateLedger({
    opening: 100,
    closing: 80,
    credits: info.credits,
    completeDay: true,
    openingFresh: true,
    closingFresh: true,
  });
  assert.equal(verdict.status, 'complete');
  assert.equal(verdict.consumption, 20);
  db.close();
});

test('窗口不完整或未覆盖区间时不被采用', () => {
  const db = memoryDb();
  // status=partial 的窗口
  upsertCreditWindow(db, {
    accountId: 'acc',
    windowStart: FROM,
    windowEnd: TO,
    credits: 5,
    status: 'partial',
  });
  assert.equal(readCreditsBetween(db, 'acc', FROM, TO).credits, null);
  // 覆盖不足（只盖到 TO-1）
  upsertCreditWindow(db, {
    accountId: 'acc',
    windowStart: FROM,
    windowEnd: TO - 1,
    credits: 7,
  });
  assert.equal(readCreditsBetween(db, 'acc', FROM, TO).credits, null);
  // 起点晚于 from
  upsertCreditWindow(db, {
    accountId: 'acc',
    windowStart: FROM + 1,
    windowEnd: TO,
    credits: 9,
  });
  assert.equal(readCreditsBetween(db, 'acc', FROM, TO).credits, null);
  db.close();
});

test('多个完整窗口时取最短覆盖窗口', () => {
  const db = memoryDb();
  upsertCreditWindow(db, { accountId: 'acc', windowStart: FROM - 10 * DAY, windowEnd: TO + 10 * DAY, credits: 100 });
  upsertCreditWindow(db, { accountId: 'acc', windowStart: FROM, windowEnd: TO, credits: 3 });
  assert.equal(readCreditsBetween(db, 'acc', FROM, TO).credits, 3);
  // upsert 覆盖同一窗口
  upsertCreditWindow(db, { accountId: 'acc', windowStart: FROM, windowEnd: TO, credits: 4 });
  assert.equal(readCreditsBetween(db, 'acc', FROM, TO).credits, 4);
  db.close();
});

test('余额快照：容差内 fresh，旧值 not fresh，未来值不采用', () => {
  const db = memoryDb();
  insertBalance(db, 'acc', FROM - 5 * 60000, 500, { rawBalance: 500000000, rawUnit: 'quota' });
  const fresh = readBalanceAt(db, 'acc', FROM);
  assert.equal(fresh.balance, 500);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.raw_balance, 500000000);
  assert.equal(fresh.raw_unit, 'quota');

  // 一小时的旧快照不算边界余额
  insertBalance(db, 'stale', FROM - 60 * 60000, 400);
  const stale = readBalanceAt(db, 'stale', FROM);
  assert.equal(stale.balance, 400);
  assert.equal(stale.fresh, false);

  // 只有未来快照时返回 null，不把后来的余额当边界值
  insertBalance(db, 'future', FROM + 5 * 60000, 700);
  assert.equal(readBalanceAt(db, 'future', FROM), null);

  // 容差可调
  assert.equal(readBalanceAt(db, 'stale', FROM, 2 * 3600000).fresh, true);
  assert.equal(BALANCE_FRESH_TOLERANCE_MS, 600000);
  db.close();
});

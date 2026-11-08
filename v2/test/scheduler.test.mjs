/**
 * 整点对齐延迟单测：整点前后、跨日、跨月、最小延迟。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { nextHourDelayMs } from '../jobs/scheduler.mjs';

test('nextHourDelayMs：整点前 1 秒等待到下一个整点 + 10 秒', () => {
  const hour = Date.UTC(2026, 0, 15, 10, 0, 0);
  const now = hour - 1000;
  assert.equal(nextHourDelayMs(now), 11_000);
  assert.equal(now + nextHourDelayMs(now), hour + 10_000);
});

test('nextHourDelayMs：整点后 1 秒等到下一个整点', () => {
  const hour = Date.UTC(2026, 0, 15, 10, 0, 0);
  const now = hour + 1000;
  assert.equal(nextHourDelayMs(now), 60 * 60 * 1000 - 1000 + 10_000);
  assert.equal(now + nextHourDelayMs(now), hour + 60 * 60 * 1000 + 10_000);
});

test('nextHourDelayMs：恰好整点等下一个整点，不立即触发', () => {
  const hour = Date.UTC(2026, 0, 15, 10, 0, 0);
  assert.equal(nextHourDelayMs(hour), 60 * 60 * 1000 + 10_000);
});

test('nextHourDelayMs：跨日', () => {
  const now = Date.UTC(2026, 0, 15, 23, 59, 59);
  assert.equal(nextHourDelayMs(now), 11_000);
  assert.equal(now + nextHourDelayMs(now), Date.UTC(2026, 0, 16, 0, 0, 10));
});

test('nextHourDelayMs：跨月（月末到次月 1 日）', () => {
  const now = Date.UTC(2026, 0, 31, 23, 59, 59);
  assert.equal(nextHourDelayMs(now), 11_000);
  assert.equal(now + nextHourDelayMs(now), Date.UTC(2026, 1, 1, 0, 0, 10));
});

test('nextHourDelayMs：延迟不小于 1000ms', () => {
  const hour = Date.UTC(2026, 0, 15, 10, 0, 0);
  for (const offset of [-1, 0, 1, 59_999, 60_000]) {
    assert.ok(nextHourDelayMs(hour + offset) >= 1000);
  }
});

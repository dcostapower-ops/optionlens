import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, marketStatus } from '../src/market-hours.js';

test('regular session is open at 10:00 ET (EDT)', () => {
  assert.equal(marketStatus(new Date('2026-10-27T14:00:00Z')).open, true);
});

test('closed before 09:30 and after 16:00 ET', () => {
  assert.equal(marketStatus(new Date('2026-10-27T13:25:00Z')).open, false);
  assert.equal(marketStatus(new Date('2026-10-27T20:05:00Z')).open, false);
});

test('EST shift: 09:35 ET in December is 14:35 UTC', () => {
  assert.equal(marketStatus(new Date('2026-12-01T14:35:00Z')).open, true);
  assert.equal(marketStatus(new Date('2026-12-01T13:35:00Z')).open, false);
});

test('weekend and holiday closed', () => {
  assert.equal(marketStatus(new Date('2026-10-31T15:00:00Z')).open, false);
  assert.equal(marketStatus(new Date('2026-11-26T15:00:00Z')).open, false);
});

test('early close day stops at 13:00 ET', () => {
  assert.equal(marketStatus(new Date('2026-11-27T17:55:00Z')).open, true);
  assert.equal(marketStatus(new Date('2026-11-27T18:05:00Z')).open, false);
});

test('date helpers', () => {
  assert.equal(addDays('2026-10-27', 45), '2026-12-11');
  assert.equal(daysBetween('2026-10-27', '2026-12-11'), 45);
});

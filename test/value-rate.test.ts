/**
 * The hourly-rate policy and its resolution order.
 *
 * Pure functions over data, so every case here is deterministic: no clock, no
 * filesystem, no server. The order `user > department > company > ARK default`
 * is the contract Issue #41 fixes, and it is pinned one branch at a time -
 * including the branches that must *not* fall through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARK_DEFAULT_CURRENCY,
  ARK_DEFAULT_HOURLY_RATE_MINOR,
  MAX_HOURLY_RATE_MINOR,
  RATE_RESOLUTION_ORDER,
  hourlyRateFromMonthlyCost,
  instantKey,
  isCurrencyCode,
  isIsoInstant,
  minorUnitExponent,
  resolveHourlyRate,
  roundHalfUp,
  timeValueMinor,
} from '../src/domain/rate.ts';
import { COMPANY, makePolicy, makeRateEntry } from './valueHelpers.ts';

const AT = '2026-05-31T23:59:59Z';

const FULL_CHAIN = makePolicy([
  makeRateEntry({ scope: 'company', scope_id: COMPANY, hourly_rate_minor: 4000 }),
  makeRateEntry({ scope: 'department', scope_id: 'dev', hourly_rate_minor: 5200 }),
  makeRateEntry({ scope: 'user', scope_id: 'u-1', hourly_rate_minor: 12000, basis: 'time_value' }),
]);

function resolve(policy = FULL_CHAIN, request: Partial<Parameters<typeof resolveHourlyRate>[1]> = {}) {
  return resolveHourlyRate(policy, {
    user_id: null,
    department_id: null,
    company_id: COMPANY,
    at: AT,
    expected_currency: null,
    ...request,
  });
}

test('the resolution order is fixed and most-specific-first', () => {
  assert.deepEqual([...RATE_RESOLUTION_ORDER], ['user', 'department', 'company']);
});

test('a user rate wins over the department, the company and the ARK default', () => {
  const result = resolve(FULL_CHAIN, { user_id: 'u-1', department_id: 'dev' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.evidence.resolved_source, 'user');
  assert.equal(result.evidence.hourly_rate_minor, 12000);
  // The owner case: opportunity cost, kept apart from payroll by the basis.
  assert.equal(result.evidence.basis, 'time_value');
});

test('without a user rate the chain falls through to the department', () => {
  const result = resolve(FULL_CHAIN, { user_id: 'u-nobody', department_id: 'dev' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.evidence.resolved_source, 'department');
  assert.equal(result.evidence.hourly_rate_minor, 5200);
  assert.equal(result.evidence.scope_id, 'dev');
});

test('without a department rate it falls through to the company', () => {
  const result = resolve(FULL_CHAIN, { user_id: 'u-nobody', department_id: 'sales' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.evidence.resolved_source, 'company');
  assert.equal(result.evidence.hourly_rate_minor, 4000);
});

test('with nothing in the policy the ARK default answers, and says so', () => {
  const result = resolve(makePolicy([]), { user_id: 'u-1', department_id: 'dev' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  // 3,400 JPY/hour. JPY has no minor unit, so the minor amount is the amount.
  assert.equal(ARK_DEFAULT_HOURLY_RATE_MINOR, 3400);
  assert.equal(minorUnitExponent(ARK_DEFAULT_CURRENCY), 0);
  assert.equal(result.evidence.hourly_rate_minor, 3400);
  assert.equal(result.evidence.currency, 'JPY');
  assert.equal(result.evidence.resolved_source, 'ark_default');
  // It belongs to no scope and claims neither payroll nor an opportunity cost.
  assert.equal(result.evidence.scope, null);
  assert.equal(result.evidence.scope_id, null);
  assert.equal(result.evidence.basis, 'fallback_proxy');
  assert.equal(result.evidence.input_method, 'ark_default');
});

test('a scope with no id offered is skipped rather than matched', () => {
  const result = resolve(FULL_CHAIN, { user_id: null, department_id: '' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.evidence.resolved_source, 'company');
});

test('a rate is resolved at an instant, so a later entry cannot win a past one', () => {
  const policy = makePolicy([
    makeRateEntry({
      scope: 'user',
      scope_id: 'u-1',
      effective_from: '2026-01-01T00:00:00Z',
      hourly_rate_minor: 9000,
    }),
    makeRateEntry({
      scope: 'user',
      scope_id: 'u-1',
      effective_from: '2026-08-01T00:00:00Z',
      hourly_rate_minor: 15000,
    }),
  ]);

  const may = resolve(policy, { user_id: 'u-1', at: '2026-05-31T23:59:59Z' });
  assert.equal(may.status, 'resolved');
  if (may.status !== 'resolved') return;
  assert.equal(may.evidence.hourly_rate_minor, 9000);
  // The period is stated, not implied: this is what makes a past figure
  // auditable after the policy has moved on.
  assert.equal(may.evidence.effective_from, '2026-01-01T00:00:00Z');
  assert.equal(may.evidence.effective_to, '2026-08-01T00:00:00Z');

  const september = resolve(policy, { user_id: 'u-1', at: '2026-09-01T00:00:00Z' });
  assert.equal(september.status, 'resolved');
  if (september.status !== 'resolved') return;
  assert.equal(september.evidence.hourly_rate_minor, 15000);
  assert.equal(september.evidence.effective_to, null, 'the newest entry is open-ended');
});

test('an instant before every entry falls through to the next scope', () => {
  const policy = makePolicy([
    makeRateEntry({ scope: 'user', scope_id: 'u-1', effective_from: '2026-06-01T00:00:00Z' }),
    makeRateEntry({ scope: 'company', scope_id: COMPANY, effective_from: '2026-01-01T00:00:00Z' }),
  ]);
  const result = resolve(policy, { user_id: 'u-1', at: '2026-03-01T00:00:00Z' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.evidence.resolved_source, 'company');
});

test('a currency the caller did not expect fails closed instead of substituting', () => {
  const policy = makePolicy([
    makeRateEntry({ scope: 'user', scope_id: 'u-1', currency: 'USD', hourly_rate_minor: 8500 }),
    makeRateEntry({ scope: 'company', scope_id: COMPANY, currency: 'JPY' }),
  ]);
  const result = resolve(policy, { user_id: 'u-1', expected_currency: 'JPY' });
  // Falling through to the company rate would silently swap one person's money
  // for another's, which is a re-attribution, not a fallback.
  assert.deepEqual(result, { status: 'unavailable', reason: 'currency_mismatch' });
});

test('the ARK default is refused for a non-JPY expectation rather than converted', () => {
  const result = resolve(makePolicy([]), { expected_currency: 'USD' });
  assert.deepEqual(result, { status: 'unavailable', reason: 'currency_mismatch' });
});

test('an unusable instant or currency is invalid_request, never coerced to now', () => {
  assert.deepEqual(resolve(FULL_CHAIN, { at: 'yesterday' }), {
    status: 'unavailable',
    reason: 'invalid_request',
  });
  assert.deepEqual(resolve(FULL_CHAIN, { at: '2026-13-99T00:00:00Z' }), {
    status: 'unavailable',
    reason: 'invalid_request',
  });
  assert.deepEqual(resolve(FULL_CHAIN, { expected_currency: 'yen' }), {
    status: 'unavailable',
    reason: 'invalid_request',
  });
});

test('the resolved evidence carries the policy version it came from', () => {
  const result = resolve(makePolicy([...FULL_CHAIN.entries], '2026-08'), { user_id: 'u-1' });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.evidence.policy_version, '2026-08');
  assert.equal(result.evidence.resolved_at, AT);
});

// ------------------------------------------------------- calculated input ---

test('monthly employer cost over monthly hours produces the hourly rate', () => {
  // No individual salary is an input, and none is retained.
  assert.deepEqual(hourlyRateFromMonthlyCost(640000, 160), { ok: true, hourly_rate_minor: 4000 });
  assert.deepEqual(hourlyRateFromMonthlyCost(672000, 160), { ok: true, hourly_rate_minor: 4200 });
});

test('a fractional result is rounded half-up, once, in one place', () => {
  assert.equal(roundHalfUp(0.5), 1);
  assert.equal(roundHalfUp(1.4999), 1);
  // 500000 / 163 = 3067.48...
  assert.deepEqual(hourlyRateFromMonthlyCost(500000, 163), { ok: true, hourly_rate_minor: 3067 });
});

test('a calculated rate that rounds to zero is refused rather than stored', () => {
  // A stored 0 would silently zero every future estimate, which is exactly the
  // "missing is not zero" rule the issue states.
  assert.deepEqual(hourlyRateFromMonthlyCost(1, 744), { ok: false, error: 'rate_not_positive' });
});

test('zero, negative, non-finite and non-integer inputs are all refused', () => {
  assert.deepEqual(hourlyRateFromMonthlyCost(0, 160), { ok: false, error: 'cost_out_of_range' });
  assert.deepEqual(hourlyRateFromMonthlyCost(-1, 160), { ok: false, error: 'cost_out_of_range' });
  assert.deepEqual(hourlyRateFromMonthlyCost(Number.NaN, 160), { ok: false, error: 'cost_not_finite' });
  assert.deepEqual(hourlyRateFromMonthlyCost(Number.POSITIVE_INFINITY, 160), {
    ok: false,
    error: 'cost_not_finite',
  });
  assert.deepEqual(hourlyRateFromMonthlyCost(1000.5, 160), { ok: false, error: 'cost_not_integer' });
  assert.deepEqual(hourlyRateFromMonthlyCost(640000, 0), { ok: false, error: 'hours_out_of_range' });
  assert.deepEqual(hourlyRateFromMonthlyCost(640000, -8), { ok: false, error: 'hours_out_of_range' });
  assert.deepEqual(hourlyRateFromMonthlyCost(640000, Number.NaN), {
    ok: false,
    error: 'hours_not_finite',
  });
  assert.deepEqual(hourlyRateFromMonthlyCost(640000, 745), { ok: false, error: 'hours_out_of_range' });
});

// ------------------------------------------------------------ conversion ---

test('minutes are valued in exact integer arithmetic', () => {
  assert.equal(timeValueMinor(3400, 60), 3400);
  assert.equal(timeValueMinor(3400, 240), 13600);
  assert.equal(timeValueMinor(12000, 480), 96000);
  // Six minutes at 3,400/hour is 340 exactly; a float path would show 340.0000…
  assert.equal(timeValueMinor(3400, 6), 340);
  assert.equal(timeValueMinor(3400, 0), 0, 'zero minutes is a known zero, not an absence');
});

test('an out-of-range rate or duration produces null, never a number', () => {
  assert.equal(timeValueMinor(0, 60), null);
  assert.equal(timeValueMinor(-1, 60), null);
  assert.equal(timeValueMinor(Number.NaN, 60), null);
  assert.equal(timeValueMinor(MAX_HOURLY_RATE_MINOR + 1, 60), null);
  assert.equal(timeValueMinor(3400, -1), null);
  assert.equal(timeValueMinor(3400, 1.5), null);
});

test('the product of the stated ceilings stays exact in a double', () => {
  assert.ok(MAX_HOURLY_RATE_MINOR * 10_000_000 < Number.MAX_SAFE_INTEGER);
});

// -------------------------------------------------------------- grammars ---

test('a currency code is three upper-case letters and nothing else', () => {
  assert.equal(isCurrencyCode('JPY'), true);
  assert.equal(isCurrencyCode('USD'), true);
  assert.equal(isCurrencyCode('jpy'), false);
  assert.equal(isCurrencyCode('JPYY'), false);
  assert.equal(isCurrencyCode('¥'), false);
  assert.equal(isCurrencyCode(42), false);
});

test('an instant must both look like ISO-8601 and parse', () => {
  assert.equal(isIsoInstant('2026-01-01T00:00:00Z'), true);
  assert.equal(isIsoInstant('2026-01-01T00:00:00.123+09:00'), true);
  assert.equal(isIsoInstant('2026-01-01'), false, 'a date alone is not an instant');
  assert.equal(isIsoInstant('2026-01-01T00:00:00'), false, 'an offset is required');
  assert.equal(isIsoInstant('2026-13-01T00:00:00Z'), false, 'and it has to parse');
  assert.equal(isIsoInstant('2026-01-01T25:00:00Z'), false);
  assert.equal(isIsoInstant(0), false);
});

test('an instant is keyed by the moment it names, not by how it was written', () => {
  // Every spelling `isIsoInstant` admits for one moment has to collapse onto a
  // single key: this is what stops two entries for one scope coexisting and
  // leaving "the rate in force" to array position.
  const midnightUtc = instantKey('2026-08-01T00:00:00Z');
  assert.equal(instantKey('2026-08-01T00:00:00.000Z'), midnightUtc);
  assert.equal(instantKey('2026-08-01T09:00:00+09:00'), midnightUtc);
  assert.equal(instantKey('2026-07-31T19:00:00-05:00'), midnightUtc);

  // Different moments stay different, including one millisecond apart.
  assert.notEqual(instantKey('2026-08-01T00:00:00.001Z'), midnightUtc);
  assert.notEqual(instantKey('2026-08-01T00:00:01Z'), midnightUtc);

  // A string that never parsed cannot borrow another value's key, and cannot
  // collide with the numeric form either.
  assert.equal(instantKey('not-an-instant'), instantKey('not-an-instant'));
  assert.notEqual(instantKey('not-an-instant'), instantKey('also-not'));
  assert.notEqual(instantKey(String(Date.parse('2026-08-01T00:00:00Z'))), midnightUtc);
});

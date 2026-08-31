/**
 * The business-value contract and the `time_value_proxy` derivation.
 *
 * The three properties the issue turns on are pinned here:
 * `time_value_proxy` is always estimated, it is a *separate* record from the
 * `time_saved` observation it came from, and a rate changed later never
 * restates a figure that already exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REALIZATION_STATUSES,
  VALUE_METRIC_RULES,
  VALUE_METRIC_TYPES,
  MAX_VALUE_QUANTITY_MINOR,
  checkValueRecord,
  deriveTimeValueProxies,
  deriveTimeValueProxy,
  timeValueProxyId,
} from '../src/domain/value.ts';
import { DEFAULT_VALUE_LEDGER_LIMITS } from '../src/domain/valueLedger.ts';
import { COMPANY, makeMonetary, makePolicy, makeRateEntry, makeTimeSaved } from './valueHelpers.ts';

const POLICY = makePolicy(
  [
    makeRateEntry({ scope: 'company', scope_id: COMPANY, hourly_rate_minor: 4000 }),
    makeRateEntry({ scope: 'user', scope_id: 'u-1', hourly_rate_minor: 12000, basis: 'time_value' }),
  ],
  '2026-08',
);

// ---------------------------------------------------------- the contract ---

test('the metric table fixes value_kind and the statuses each type may take', () => {
  assert.deepEqual([...VALUE_METRIC_TYPES].sort(), [
    'gross_profit_contribution',
    'quality_error_reduction',
    'realized_cost_saving',
    'response_time_improvement',
    'revenue_contribution',
    'throughput_improvement',
    'time_saved',
    'time_value_proxy',
  ]);
  // The two hard constraints of §7.1.2, as data rather than as a code path.
  assert.deepEqual([...VALUE_METRIC_RULES.time_value_proxy.realization_statuses], ['estimated']);
  assert.deepEqual([...VALUE_METRIC_RULES.realized_cost_saving.realization_statuses], ['realized']);
  // Revenue and gross profit take both, which is why the status is its own axis.
  for (const type of ['revenue_contribution', 'gross_profit_contribution'] as const) {
    assert.deepEqual([...VALUE_METRIC_RULES[type].realization_statuses], [...REALIZATION_STATUSES]);
  }
});

test('a time_value_proxy claiming realized is a contract violation, not a correction', () => {
  const record = makeMonetary({
    value_metric_type: 'time_value_proxy',
    realization_status: 'realized',
    derived_from: 'ts-1',
    rate_evidence: {
      resolved_source: 'company',
      entry_source: 'operator',
      scope: 'company',
      scope_id: COMPANY,
      hourly_rate_minor: 4000,
      currency: 'JPY',
      basis: 'employee_cost',
      input_method: 'direct',
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: null,
      resolved_at: '2026-05-31T23:59:59Z',
      policy_version: '2026-08',
    },
  });
  assert.ok(checkValueRecord(record).includes('realization_status_not_allowed'));
});

test('a realized_cost_saving claiming estimated is refused too', () => {
  const record = makeMonetary({ realization_status: 'estimated' });
  assert.ok(checkValueRecord(record).includes('realization_status_not_allowed'));
});

test('a monetary record needs an ISO 4217 unit and a non-monetary one does not', () => {
  assert.ok(checkValueRecord(makeMonetary({ unit: 'yen' })).includes('unit_not_currency'));
  assert.ok(checkValueRecord(makeTimeSaved({ unit: 'JPY' })).includes('unit_not_allowed'));
  assert.deepEqual(checkValueRecord(makeTimeSaved()), []);
  assert.deepEqual(checkValueRecord(makeMonetary()), []);
});

test('a quantity that is negative, fractional or NaN is refused, and zero is not', () => {
  assert.ok(checkValueRecord(makeTimeSaved({ quantity: -1 })).includes('quantity_negative'));
  assert.ok(checkValueRecord(makeTimeSaved({ quantity: 1.5 })).includes('quantity_not_integer'));
  assert.ok(checkValueRecord(makeTimeSaved({ quantity: Number.NaN })).includes('quantity_not_integer'));
  // Zero minutes saved is a known observation, not a missing one.
  assert.deepEqual(checkValueRecord(makeTimeSaved({ quantity: 0 })), []);
});

test('saving more time than the baseline took is a wrong baseline, not a big win', () => {
  const record = makeTimeSaved({ quantity: 200, baseline: { kind: 'prior_period', quantity: 180 } });
  assert.ok(checkValueRecord(record).includes('saving_exceeds_baseline'));
});

test('rate evidence belongs to a proxy and to nothing else', () => {
  const proxy = makeMonetary({ value_metric_type: 'time_value_proxy', realization_status: 'estimated' });
  const violations = checkValueRecord(proxy);
  assert.ok(violations.includes('proxy_requires_rate_evidence'));
  assert.ok(violations.includes('proxy_requires_derived_from'));

  const saving = makeMonetary({ derived_from: 'ts-1' });
  assert.ok(checkValueRecord(saving).includes('derived_from_not_allowed'));
});

test('a measurement window that runs backwards is refused', () => {
  const record = makeTimeSaved({
    measurement_window: { start: '2026-05-31T00:00:00Z', end: '2026-05-01T00:00:00Z' },
  });
  assert.ok(checkValueRecord(record).includes('measurement_window_invalid'));
});

// --------------------------------------------------------- the derivation ---

test('time saved times the resolved rate becomes the proxy, with the rate kept', () => {
  const source = makeTimeSaved({ attribution_scope: { company_id: COMPANY, department_id: null, user_id: 'u-1' } });
  const result = deriveTimeValueProxy(source, POLICY);
  assert.equal(result.status, 'derived');
  if (result.status !== 'derived') return;

  // 120 minutes at 12,000/hour.
  assert.equal(result.record.quantity, 24000);
  assert.equal(result.record.unit, 'JPY');
  assert.equal(result.record.value_kind, 'monetary');
  assert.equal(result.record.realization_status, 'estimated');
  assert.equal(result.record.derived_from, 'ts-1');
  assert.equal(result.record.record_id, timeValueProxyId('ts-1'));

  // Everything an audit needs, frozen at the moment of use.
  const evidence = result.record.rate_evidence;
  assert.ok(evidence !== null);
  assert.equal(evidence.hourly_rate_minor, 12000);
  assert.equal(evidence.currency, 'JPY');
  assert.equal(evidence.resolved_source, 'user');
  assert.equal(evidence.basis, 'time_value');
  assert.equal(evidence.policy_version, '2026-08');
  assert.equal(evidence.resolved_at, source.measurement_window.end);
  assert.deepEqual(checkValueRecord(result.record), []);
});

test('the source observation is left exactly as it was: two records, not one', () => {
  const source = makeTimeSaved();
  const before = structuredClone(source);
  const result = deriveTimeValueProxy(source, POLICY);
  assert.equal(result.status, 'derived');
  assert.deepEqual(source, before, 'the non-monetary observation is not rewritten');
});

test('the proxy is estimated even when the observation it came from is realized', () => {
  const source = makeTimeSaved({ realization_status: 'realized' });
  const result = deriveTimeValueProxy(source, POLICY);
  assert.equal(result.status, 'derived');
  if (result.status !== 'derived') return;
  // A measured time saving is still only an *estimate* of money, because the
  // cost may not have stopped being incurred.
  assert.equal(result.record.realization_status, 'estimated');
});

test('the rate is resolved at the end of the record window, not at "now"', () => {
  const policy = makePolicy([
    makeRateEntry({ scope: 'user', scope_id: 'u-1', effective_from: '2026-01-01T00:00:00Z', hourly_rate_minor: 9000 }),
    // Added later, for a period after the record. It must not reach backwards.
    makeRateEntry({ scope: 'user', scope_id: 'u-1', effective_from: '2026-08-01T00:00:00Z', hourly_rate_minor: 15000 }),
  ]);
  const source = makeTimeSaved({ attribution_scope: { company_id: COMPANY, department_id: null, user_id: 'u-1' } });
  const result = deriveTimeValueProxy(source, policy);
  assert.equal(result.status, 'derived');
  if (result.status !== 'derived') return;
  assert.equal(result.record.quantity, 18000, '120 minutes at the May rate of 9,000');
});

test('an existing proxy is carried forward untouched when the policy changes', () => {
  const source = makeTimeSaved({ attribution_scope: { company_id: COMPANY, department_id: null, user_id: 'u-1' } });
  const first = deriveTimeValueProxies([source], POLICY);
  assert.deepEqual(first.derived, ['ts-1#time_value_proxy']);
  const proxy = first.records.find((record) => record.value_metric_type === 'time_value_proxy');
  assert.ok(proxy !== undefined);

  // The operator backdates a completely different rate over the same period.
  const rewritten = makePolicy(
    [
      makeRateEntry({
        scope: 'user',
        scope_id: 'u-1',
        effective_from: '2020-01-01T00:00:00Z',
        hourly_rate_minor: 99000,
      }),
    ],
    '2027-01',
  );
  const second = deriveTimeValueProxies([source, proxy], rewritten);
  assert.deepEqual(second.derived, [], 'nothing is recomputed');
  assert.deepEqual(second.carried_forward, ['ts-1#time_value_proxy']);
  const after = second.records.find((record) => record.value_metric_type === 'time_value_proxy');
  assert.deepEqual(after, proxy, 'the stored evidence wins over the current policy');
});

test('an unresolvable rate produces unavailable, never a zero-yen record', () => {
  const policy = makePolicy([
    makeRateEntry({ scope: 'company', scope_id: COMPANY, currency: 'USD', hourly_rate_minor: 8500 }),
  ]);
  const source = makeTimeSaved();
  const result = deriveTimeValueProxy(source, policy, { expected_currency: 'JPY' });
  assert.equal(result.status, 'unavailable');
  if (result.status !== 'unavailable') return;
  assert.deepEqual(result.unavailable, {
    source_record_id: 'ts-1',
    reason: 'rate_currency_mismatch',
  });

  const summary = deriveTimeValueProxies([source], policy, { expected_currency: 'JPY' });
  assert.deepEqual(summary.derived, []);
  assert.equal(summary.records.length, 1, 'no record with a made-up amount is added');
  assert.equal(summary.unavailable.length, 1);
});

test('a record that is not an admissible time_saved derives nothing', () => {
  const notTime = makeMonetary();
  const result = deriveTimeValueProxy(notTime, POLICY);
  assert.deepEqual(result, {
    status: 'unavailable',
    unavailable: { source_record_id: 'm-1', reason: 'contract_violation' },
  });

  const broken = makeTimeSaved({ quantity: -5 });
  const brokenResult = deriveTimeValueProxy(broken, POLICY);
  assert.equal(brokenResult.status, 'unavailable');
});

test('a whole ledger derives once, deterministically, in source order', () => {
  const records = [
    makeTimeSaved({ record_id: 'ts-a' }),
    makeMonetary({ record_id: 'm-a' }),
    makeTimeSaved({ record_id: 'ts-b', quantity: 60 }),
  ];
  const first = deriveTimeValueProxies(records, POLICY);
  const second = deriveTimeValueProxies(records, POLICY);
  assert.deepEqual(first, second, 'the same input always folds the same way');
  assert.deepEqual(first.derived, ['ts-a#time_value_proxy', 'ts-b#time_value_proxy']);
  assert.equal(first.records.length, 5);
  // Company rate of 4,000: 120 minutes and 60 minutes.
  const amounts = first.records
    .filter((record) => record.value_metric_type === 'time_value_proxy')
    .map((record) => record.quantity);
  assert.deepEqual(amounts, [8000, 4000]);
});

test('a subtotal of a full ledger stays exact rather than quietly rounding', () => {
  // The per-record ceiling and the document ceiling are two halves of one
  // guarantee: their product has to stay inside the exact integer range, or a
  // large ledger's total would silently lose its last digits.
  assert.ok(
    MAX_VALUE_QUANTITY_MINOR * DEFAULT_VALUE_LEDGER_LIMITS.max_value_records < Number.MAX_SAFE_INTEGER,
    'the worst-case monetary subtotal is exactly representable',
  );
});

test('a derivation cannot mint an id the document already uses', () => {
  // `#` is inside the ledger identifier grammar, so a document may legally
  // declare a record with the id a derivation would produce. Producing a second
  // record under that id would break the uniqueness the validator enforces.
  const source = makeTimeSaved({ record_id: 'ts-1' });
  const squatter = makeMonetary({ record_id: timeValueProxyId('ts-1') });
  const summary = deriveTimeValueProxies([source, squatter], POLICY);
  assert.deepEqual(summary.derived, []);
  assert.deepEqual(summary.unavailable, [
    { source_record_id: 'ts-1', reason: 'proxy_id_conflict' },
  ]);
  assert.equal(summary.records.length, 2, 'and no third record is invented');
});

test('a product past the amount ceiling is unavailable, not a truncated figure', () => {
  const policy = makePolicy([
    makeRateEntry({ scope: 'company', scope_id: COMPANY, hourly_rate_minor: 100_000_000 }),
  ]);
  // 100,000,000 minor/hour over 9,000,000 minutes is 1.5e13, past the ceiling
  // that keeps a full-ledger subtotal exact.
  const source = makeTimeSaved({
    quantity: 9_000_000,
    baseline: { kind: 'manual_process_measurement', quantity: 9_000_000 },
  });
  const result = deriveTimeValueProxy(source, policy);
  assert.deepEqual(result, {
    status: 'unavailable',
    unavailable: { source_record_id: 'ts-1', reason: 'quantity_out_of_range' },
  });
});

test('an unusable resolution instant is reported as such, not silently retried', () => {
  const source = makeTimeSaved({
    measurement_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-31' },
  });
  // The window itself is refused first, which is the stricter answer.
  assert.equal(deriveTimeValueProxy(source, POLICY).status, 'unavailable');
});

test('the evidence names who supplied the winning entry, and nobody for the fallback', () => {
  const scoped = deriveTimeValueProxy(makeTimeSaved(), POLICY);
  assert.equal(scoped.status, 'derived');
  if (scoped.status !== 'derived') return;
  assert.equal(scoped.record.rate_evidence?.entry_source, 'operator');

  const fallback = deriveTimeValueProxy(makeTimeSaved(), makePolicy([]));
  assert.equal(fallback.status, 'derived');
  if (fallback.status !== 'derived') return;
  assert.equal(fallback.record.rate_evidence?.resolved_source, 'ark_default');
  assert.equal(fallback.record.rate_evidence?.entry_source, null);
});

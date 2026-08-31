/**
 * The ratio layer - benefit-cost ratio and net ROI (§8).
 *
 * Two properties are being pinned here, and both are about what the screen
 * refuses to say:
 *
 * - a ratio that cannot be computed is a *reason*, never 0, never ∞, never a
 *   blank. Every branch of §8.4's vocabulary is reached by a test, because each
 *   one exists to keep a different pair of facts apart - "the cost is zero" from
 *   "the cost is unknown", "there is no value" from "the value is not money";
 * - estimated and realized never share a numerator. `time_value_proxy` is an
 *   estimate and `realized_cost_saving` is not, and no row anywhere adds them
 *   together before dividing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RATIO_STATUSES, type RatioRow, type RatioStatus } from '../src/domain/ratio.ts';
import { validateValueLedger, valueLedgerStateFrom } from '../src/domain/valueLedger.ts';
import { buildValueSummary, type ValueDashboard } from '../src/domain/valueDashboard.ts';
import { COMPANY, makeLedgerDocument } from './valueHelpers.ts';

const AT = '2026-09-01T00:00:00Z';
const AUGUST = { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' };
const JULY = { start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z' };

function cost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cost_status: 'finalized',
    amount_minor: 42000,
    currency: 'JPY',
    pricing_source: 'provider_invoice',
    pricing_version: '2026-08',
    period: { ...AUGUST },
    ...overrides,
  };
}

function monetary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: 'rc-aug',
    value_metric_type: 'realized_cost_saving',
    value_kind: 'monetary',
    realization_status: 'realized',
    unit: 'JPY',
    quantity: 420000,
    baseline: { kind: 'contract_baseline', quantity: 900000 },
    measurement_window: { ...AUGUST },
    attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
    attribution_method: 'measured_before_after',
    confidence: 'high',
    methodology_version: 'v1',
    evidence_ref: null,
    derived_from: null,
    rate_evidence: null,
    ...overrides,
  };
}

function timeSaved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: 'ts-aug',
    value_metric_type: 'time_saved',
    value_kind: 'non_monetary',
    realization_status: 'estimated',
    unit: 'minute',
    quantity: 600,
    baseline: { kind: 'manual_process_measurement', quantity: 900 },
    measurement_window: { ...AUGUST },
    attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
    attribution_method: 'operator_declared',
    confidence: 'medium',
    methodology_version: 'v1',
    evidence_ref: null,
    derived_from: null,
    rate_evidence: null,
    ...overrides,
  };
}

function dashboardFor(
  overrides: Record<string, unknown>,
  disclosure: 'restricted' | 'full' = 'full',
): ValueDashboard {
  const summary = buildValueSummary(
    valueLedgerStateFrom(validateValueLedger(makeLedgerDocument({ ai_cost: cost(), ...overrides }))),
    disclosure,
    AT,
  );
  assert.equal(summary.status, 'accepted', JSON.stringify(summary));
  if (summary.status !== 'accepted') throw new Error('unreachable');
  return summary.dashboard;
}

function rowFor(dashboard: ValueDashboard, status: 'realized' | 'estimated'): RatioRow {
  const found = dashboard.ratios.filter((row) => row.realization_status === status);
  assert.equal(found.length, 1, `exactly one ${status} row`);
  const row = found[0];
  assert.ok(row !== undefined);
  return row;
}

// ------------------------------------------------------------- computed ---

test('the two terms are named separately, and they are different numbers', () => {
  const dashboard = dashboardFor({ value_records: [monetary()] });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'computed');
  assert.equal(realized.value_minor, 420000);
  assert.equal(realized.cost_minor, 42000);
  assert.equal(realized.benefit_cost_ratio, '10.000000');
  // §8.1: the same situation, two figures. "10倍" without saying which is the
  // exact ambiguity the vocabulary exists to remove.
  assert.equal(realized.net_roi, '9.000000');
  assert.equal(realized.cost_status, 'finalized', 'the denominator states its own status (§8.3)');
  assert.deepEqual(realized.period, AUGUST);
  assert.equal(realized.methodology_version, 'v1');
});

test('net ROI is exactly the benefit-cost ratio minus one, at any precision', () => {
  // 100,000 over 42,000 is 2.380952380..., which is not exact at six places.
  const dashboard = dashboardFor({ value_records: [monetary({ quantity: 100000 })] });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.benefit_cost_ratio, '2.380952');
  assert.equal(realized.net_roi, '1.380952', 'derived from the same rounded figure, not re-rounded');
});

test('estimated and realized get their own ratios, and nothing sums the two', () => {
  const dashboard = dashboardFor({ value_records: [monetary(), timeSaved()] });
  const realized = rowFor(dashboard, 'realized');
  const estimated = rowFor(dashboard, 'estimated');

  assert.equal(realized.ratio_status, 'computed');
  assert.equal(estimated.ratio_status, 'computed');
  // 600 minutes at the ledger's 4,000 JPY/hour is 40,000 JPY of estimate.
  assert.equal(estimated.value_minor, 40000);
  assert.equal(realized.value_minor, 420000);

  const combined = 420000 + 40000;
  for (const row of dashboard.ratios) {
    assert.notEqual(row.value_minor, combined, 'no numerator is the two added together');
  }
  assert.notEqual(realized.benefit_cost_ratio, estimated.benefit_cost_ratio);
  assert.equal(JSON.stringify(dashboard.ratios).includes(String(combined)), false);
});

test('a record outside the cost period is excluded, and the exclusion is visible', () => {
  const dashboard = dashboardFor({
    value_records: [monetary(), monetary({ record_id: 'rc-jul', measurement_window: { ...JULY } })],
  });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'computed');
  assert.equal(realized.included_record_count, 1);
  assert.equal(realized.excluded_record_count, 1, 'July money is not in an August ratio');
  assert.equal(realized.value_minor, 420000);
});

test('money that all belongs to another period is absence here, not a zero ratio', () => {
  // The records exist and are perfectly good money - they are simply not this
  // period's. The row has to say "no numerator for this period" rather than
  // divide an empty sum, and the count of what it set aside stays visible.
  const dashboard = dashboardFor({
    value_records: [monetary({ record_id: 'rc-jul', measurement_window: { ...JULY } })],
  });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'blocked_absent_value');
  assert.equal(realized.included_record_count, 0);
  assert.equal(realized.excluded_record_count, 1);
  for (const key of ['benefit_cost_ratio', 'net_roi', 'value_minor']) {
    assert.equal(Object.prototype.hasOwnProperty.call(realized, key), false, key);
  }
});

// -------------------------------------------------------------- blocked ---

test('a zero cost is undefined, not a ratio, and it is not "unpriced"', () => {
  const dashboard = dashboardFor({
    value_records: [monetary()],
    ai_cost: cost({ amount_minor: 0 }),
  });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'undefined_zero_denominator');
  assert.equal(realized.cost_status, 'finalized', 'a confirmed 0 is still a confirmed amount');
  for (const key of ['benefit_cost_ratio', 'net_roi', 'value_minor', 'cost_minor']) {
    assert.equal(Object.prototype.hasOwnProperty.call(realized, key), false, key);
  }
  const text = JSON.stringify(realized);
  assert.equal(text.includes('Infinity'), false);
  assert.equal(text.includes('null'), false, 'and not a null standing in for a number');
});

test('an unpriced cost is unknown, which is a different row from zero', () => {
  const dashboard = dashboardFor({
    value_records: [monetary()],
    ai_cost: { cost_status: 'unpriced', amount_minor: null, currency: null, pricing_source: null },
  });
  assert.equal(rowFor(dashboard, 'realized').ratio_status, 'blocked_unpriced_cost');
});

test('no cost bucket at all is its own reason, not an unpriced one', () => {
  const dashboard = dashboardFor({ value_records: [monetary()], ai_cost: null });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'blocked_absent_cost');
  assert.equal(realized.cost_status, null);
});

test('no monetary value is absence, and non-monetary value says so instead', () => {
  const absent = dashboardFor({ value_records: [] });
  assert.equal(rowFor(absent, 'realized').ratio_status, 'blocked_absent_value');
  assert.equal(rowFor(absent, 'estimated').ratio_status, 'blocked_absent_value');

  // A realized time saving is real value, and it is minutes. A ratio cannot be
  // built from it (§8.2), and saying "no value" would be false.
  const minutes = dashboardFor({
    value_records: [timeSaved({ record_id: 'ts-real', realization_status: 'realized' })],
  });
  assert.equal(rowFor(minutes, 'realized').ratio_status, 'blocked_non_monetary_operand');
  // Its derived proxy is estimated, by contract, so the estimated row computes.
  assert.equal(rowFor(minutes, 'estimated').ratio_status, 'computed');
});

test('a numerator and a denominator in different currencies do not divide', () => {
  const dashboard = dashboardFor({
    value_records: [monetary()],
    ai_cost: cost({ currency: 'USD', amount_minor: 30000 }),
  });
  assert.equal(rowFor(dashboard, 'realized').ratio_status, 'blocked_currency_mismatch');
});

test('a cost with no stated period cannot be matched to a measurement window', () => {
  const dashboard = dashboardFor({
    value_records: [monetary()],
    ai_cost: cost({ period: undefined }),
  });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'blocked_scope_mismatch');
  assert.equal(realized.period, null);
});

test('a record straddling the period boundary blocks the row rather than being clipped', () => {
  const dashboard = dashboardFor({
    value_records: [
      monetary({
        record_id: 'rc-straddle',
        measurement_window: { start: '2026-07-15T00:00:00Z', end: '2026-08-15T00:00:00Z' },
      }),
    ],
  });
  assert.equal(rowFor(dashboard, 'realized').ratio_status, 'blocked_scope_mismatch');
});

test('numerator records computed two different ways are not compared', () => {
  const dashboard = dashboardFor({
    value_records: [
      monetary(),
      monetary({ record_id: 'rc-2', quantity: 100000, methodology_version: 'v2' }),
    ],
  });
  const realized = rowFor(dashboard, 'realized');
  assert.equal(realized.ratio_status, 'blocked_methodology_mismatch');
  assert.equal(realized.methodology_version, null);
  assert.equal(Object.prototype.hasOwnProperty.call(realized, 'value_minor'), false);
});

// ------------------------------------------------------------ disclosure ---

test('under restriction the reason survives and every figure is withheld', () => {
  const dashboard = dashboardFor({ value_records: [monetary(), timeSaved()] }, 'restricted');
  for (const row of dashboard.ratios) {
    assert.equal(row.ratio_status, 'computed');
    assert.equal(row.amount_withheld, true);
    for (const key of ['benefit_cost_ratio', 'net_roi', 'value_minor', 'cost_minor']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, key), false, key);
    }
  }
  const text = JSON.stringify(dashboard.ratios);
  for (const amount of ['420000', '42000', '40000', '10.000000', '9.000000']) {
    assert.equal(text.includes(amount), false, amount);
  }
});

// -------------------------------------------------------- the vocabulary ---

test('every reason a row can carry is inside the closed vocabulary', () => {
  const seen = new Set<RatioStatus>();
  const documents: Record<string, unknown>[] = [
    { value_records: [monetary()] },
    { value_records: [monetary()], ai_cost: cost({ amount_minor: 0 }) },
    {
      value_records: [monetary()],
      ai_cost: { cost_status: 'unpriced', amount_minor: null, currency: null, pricing_source: null },
    },
    { value_records: [monetary()], ai_cost: null },
    { value_records: [] },
    { value_records: [timeSaved({ record_id: 'ts-real', realization_status: 'realized' })] },
    { value_records: [monetary()], ai_cost: cost({ currency: 'USD' }) },
    { value_records: [monetary()], ai_cost: cost({ period: undefined }) },
    {
      value_records: [
        monetary({ measurement_window: { start: '2026-07-15T00:00:00Z', end: '2026-08-15T00:00:00Z' } }),
      ],
    },
    {
      value_records: [monetary(), monetary({ record_id: 'rc-2', methodology_version: 'v2' })],
    },
  ];
  for (const document of documents) {
    for (const row of dashboardFor(document).ratios) seen.add(row.ratio_status);
  }

  for (const status of seen) {
    assert.ok((RATIO_STATUSES as readonly string[]).includes(status), status);
  }
  // Everything except the member reserved for provider usage telemetry, which
  // this build cannot produce at all (see `ratio.ts`).
  const unreached = RATIO_STATUSES.filter((status) => !seen.has(status));
  assert.deepEqual(unreached, ['blocked_unresolved_cost']);
});

test('the separation and the refusals are stated in words on the payload', () => {
  const dashboard = dashboardFor({ value_records: [] });
  assert.ok(dashboard.notes.some((note) => note.includes('1つの比率には混ぜません')));
  assert.ok(dashboard.notes.some((note) => note.includes('0倍や∞は表示しません')));
});

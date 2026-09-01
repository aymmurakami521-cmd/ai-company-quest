/**
 * FX conversion - aggregation mode B (§7.3.1).
 *
 * What is being held here is mostly a set of refusals. Converting money is easy;
 * the hard part is that every path which *cannot* convert has to end in an
 * explicit "no figure", never in a zero, never in an amount left in the wrong
 * currency inside a reporting-currency total, and never in a rate that came
 * from anywhere but the operator's own document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { divideHalfUp, formatFixed, scaledQuotient } from '../src/domain/decimal.ts';
import {
  convertMinor,
  fxRateDecimal,
  resolveFxRate,
  VALUE_AGGREGATION_MODES,
  type FxPolicy,
  type FxRateEntry,
} from '../src/domain/fx.ts';
import { validateValueLedger, valueLedgerStateFrom } from '../src/domain/valueLedger.ts';
import { buildValueSummary, type ValueDashboard } from '../src/domain/valueDashboard.ts';
import { COMPANY, makeLedgerDocument } from './valueHelpers.ts';

const AT = '2026-09-01T00:00:00Z';
const REPO_ROOT = new URL('..', import.meta.url);

const AUGUST = { start: '2026-08-01T00:00:00Z', end: '2026-08-31T23:59:59Z' };

function usdRate(overrides: Partial<FxRateEntry> = {}): FxRateEntry {
  return {
    from_currency: 'USD',
    to_currency: 'JPY',
    effective_from: '2026-01-01T00:00:00Z',
    from_amount_minor: 10000,
    to_amount_minor: 14825,
    fx_source: 'published_reference',
    fx_rate_version: '2026-08',
    ...overrides,
  };
}

function policy(entries: FxRateEntry[]): FxPolicy {
  return { entries };
}

/** One monetary record, as an operator writes it. */
function monetaryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: 'rev-1',
    value_metric_type: 'revenue_contribution',
    value_kind: 'monetary',
    realization_status: 'realized',
    unit: 'USD',
    quantity: 200000,
    baseline: { kind: 'prior_period', quantity: 0 },
    measurement_window: { ...AUGUST },
    attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
    attribution_method: 'operator_declared',
    confidence: 'high',
    methodology_version: 'v1',
    evidence_ref: null,
    derived_from: null,
    rate_evidence: null,
    ...overrides,
  };
}

function dashboardFor(
  document: Record<string, unknown>,
  disclosure: 'restricted' | 'full' = 'full',
): ValueDashboard {
  const summary = buildValueSummary(
    valueLedgerStateFrom(validateValueLedger(document)),
    disclosure,
    AT,
  );
  assert.equal(summary.status, 'accepted', JSON.stringify(summary));
  if (summary.status !== 'accepted') throw new Error('unreachable');
  return summary.dashboard;
}

function rejectionFor(document: Record<string, unknown>): { field: string; rule: string } {
  const result = validateValueLedger(document);
  assert.equal(result.ok, false, 'the document must be refused');
  if (result.ok) throw new Error('unreachable');
  return { field: result.field, rule: result.rule };
}

// ------------------------------------------------------------- decimals ---

test('rounding is half away from zero, and it is the only rounding step', () => {
  assert.equal(divideHalfUp(5n, 10n), 1n, '0.5 rounds up');
  assert.equal(divideHalfUp(4n, 10n), 0n);
  assert.equal(divideHalfUp(15n, 10n), 2n, '1.5 rounds up');
  assert.equal(divideHalfUp(25n, 10n), 3n, '2.5 rounds up, not to even');
  assert.equal(divideHalfUp(-5n, 10n), -1n, 'and a negative rounds the same distance');
  assert.equal(divideHalfUp(1n, 0n), null, 'a zero denominator is not an answer');
  assert.equal(divideHalfUp(1n, -2n), null);
});

test('a scaled quotient is exact well past what a double could hold', () => {
  // 4.096e15 minor units over one, at six decimal places, is 4.096e21 - past
  // Number.MAX_SAFE_INTEGER, which is exactly why the wire form is a string.
  const scaled = scaledQuotient(4_096_000_000_000_000n, 1n, 6);
  assert.ok(scaled !== null);
  assert.equal(formatFixed(scaled, 6), '4096000000000000.000000');
  assert.equal(formatFixed(-1n, 6), '-0.000001');
  assert.equal(formatFixed(0n, 6), '0.000000');
});

// ------------------------------------------------------- the rate policy ---

test('a rate is exactly the pair of minor amounts the operator wrote', () => {
  assert.equal(fxRateDecimal(10000, 14825), '1.482500');
  assert.equal(fxRateDecimal(1, 3), '3.000000');
  assert.equal(fxRateDecimal(0, 100), null, 'a zero leg is not a rate');
  assert.equal(fxRateDecimal(100, 0), null);
});

test('the rate in force at the instant asked for is the one that answers', () => {
  const later = usdRate({ effective_from: '2026-06-01T00:00:00Z', to_amount_minor: 16000 });
  const resolution = resolveFxRate(policy([usdRate(), later]), {
    from_currency: 'USD',
    to_currency: 'JPY',
    at: '2026-03-01T00:00:00Z',
  });
  assert.equal(resolution.status, 'resolved');
  if (resolution.status !== 'resolved') return;
  assert.equal(resolution.evidence.to_amount_minor, 14825, 'the June rate has not started yet');
  assert.equal(
    resolution.evidence.fx_effective_to,
    '2026-06-01T00:00:00Z',
    'and the evidence states when it stopped applying',
  );
  assert.equal(resolution.evidence.fx_effective_at, '2026-03-01T00:00:00Z');
});

test('a rate added later cannot reach back into an earlier period', () => {
  const before = resolveFxRate(policy([usdRate()]), {
    from_currency: 'USD',
    to_currency: 'JPY',
    at: '2025-12-31T23:59:59Z',
  });
  assert.deepEqual(before, { status: 'unavailable', reason: 'no_applicable_rate' });
});

test('a rate is not inverted, and it is not triangulated', () => {
  const entries = [usdRate(), usdRate({ from_currency: 'JPY', to_currency: 'EUR' })];
  const inverted = resolveFxRate(policy(entries), {
    from_currency: 'JPY',
    to_currency: 'USD',
    at: AT,
  });
  assert.deepEqual(inverted, { status: 'unavailable', reason: 'no_applicable_rate' });

  const triangulated = resolveFxRate(policy(entries), {
    from_currency: 'USD',
    to_currency: 'EUR',
    at: AT,
  });
  assert.deepEqual(triangulated, { status: 'unavailable', reason: 'no_applicable_rate' });
});

test('an identity conversion and an unusable request are refused, not answered', () => {
  for (const request of [
    { from_currency: 'JPY', to_currency: 'JPY', at: AT },
    { from_currency: 'jpy', to_currency: 'USD', at: AT },
    { from_currency: 'JPY', to_currency: 'USD', at: 'yesterday' },
  ]) {
    assert.deepEqual(resolveFxRate(policy([usdRate()]), request), {
      status: 'unavailable',
      reason: 'invalid_request',
    });
  }
});

test('conversion is exact integer arithmetic, and a result past the ceiling is no result', () => {
  const resolution = resolveFxRate(policy([usdRate()]), {
    from_currency: 'USD',
    to_currency: 'JPY',
    at: AT,
  });
  assert.equal(resolution.status, 'resolved');
  if (resolution.status !== 'resolved') return;

  assert.equal(convertMinor(200000, resolution.evidence, 1_000_000_000_000), 296500);
  // 1 minor unit at 1.4825 is 1.4825, which rounds to 1 - not to 0, and not
  // through a float.
  assert.equal(convertMinor(1, resolution.evidence, 1_000_000_000_000), 1);
  assert.equal(convertMinor(200000, resolution.evidence, 296_499), null, 'past the ceiling is null');
  assert.equal(convertMinor(-1, resolution.evidence, 1_000_000_000_000), null);
  assert.equal(convertMinor(1.5, resolution.evidence, 1_000_000_000_000), null);
});

// --------------------------------------------------- the ledger document ---

test('the aggregation mode is stated by the operator, and defaults to the partition', () => {
  const ledger = validateValueLedger(makeLedgerDocument());
  assert.ok(ledger.ok);
  assert.equal(ledger.ledger.aggregation_mode, 'currency_partition');
  assert.deepEqual(ledger.ledger.fx_policy.entries, []);

  assert.deepEqual(rejectionFor(makeLedgerDocument({ aggregation_mode: 'whatever' })), {
    field: 'aggregation_mode',
    rule: 'invalid_format',
  });
  assert.deepEqual(VALUE_AGGREGATION_MODES.slice(), [
    'currency_partition',
    'reporting_currency_normalized',
  ]);
});

test('an FX entry is refused for every way it could be nonsense', () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ from_currency: 'usd' }, 'fx_rates[0].from_currency', 'invalid_format'],
    [{ to_currency: 7 }, 'fx_rates[0].to_currency', 'type_error'],
    [{ to_currency: 'USD' }, 'fx_rates[0].to_currency', 'contract_violation'],
    [{ effective_from: '2026-01-01' }, 'fx_rates[0].effective_from', 'invalid_format'],
    [{ from_amount_minor: 0 }, 'fx_rates[0].from_amount_minor', 'invalid_format'],
    [{ to_amount_minor: -1 }, 'fx_rates[0].to_amount_minor', 'invalid_format'],
    [{ to_amount_minor: 1.5 }, 'fx_rates[0].to_amount_minor', 'invalid_format'],
    [{ to_amount_minor: Number.NaN }, 'fx_rates[0].to_amount_minor', 'invalid_format'],
    [{ from_amount_minor: '10000' }, 'fx_rates[0].from_amount_minor', 'type_error'],
    [{ fx_source: 'bloomberg' }, 'fx_rates[0].fx_source', 'invalid_format'],
    [{ fx_rate_version: '' }, 'fx_rates[0].fx_rate_version', 'invalid_format'],
  ];
  for (const [override, field, rule] of cases) {
    assert.deepEqual(
      rejectionFor(makeLedgerDocument({ fx_rates: [{ ...usdRate(), ...override }] })),
      { field, rule },
      JSON.stringify(override),
    );
  }
});

test('two rates for one pair starting at the same instant are refused, not tie-broken', () => {
  assert.deepEqual(
    rejectionFor(makeLedgerDocument({ fx_rates: [usdRate(), usdRate({ to_amount_minor: 16000 })] })),
    { field: 'fx_rates[1].effective_from', rule: 'duplicate_id' },
  );
});

test('one instant written two ways is still one instant, in either document order', () => {
  // `2026-08-01T00:00:00Z` and `2026-08-01T09:00:00+09:00` are the same moment.
  // Keyed by their text they would both validate, and `matchPair` would then
  // hand the tie to whichever came first in the array: the same ledger, with
  // the two entries swapped, would convert at a different rate. Both spellings
  // must be refused, and refused the same way whichever order they arrive in.
  const spellings = [
    ['2026-08-01T00:00:00Z', '2026-08-01T09:00:00+09:00'],
    ['2026-08-01T00:00:00Z', '2026-08-01T00:00:00.000Z'],
    ['2026-08-01T00:00:00.000000Z', '2026-07-31T19:00:00-05:00'],
  ];
  for (const [first, second] of spellings) {
    const a = usdRate({ effective_from: first, to_amount_minor: 14825 });
    const b = usdRate({ effective_from: second, to_amount_minor: 20000 });
    // The second entry is named in both directions, so neither ordering can be
    // the one that quietly wins.
    assert.deepEqual(
      rejectionFor(makeLedgerDocument({ fx_rates: [a, b] })),
      { field: 'fx_rates[1].effective_from', rule: 'duplicate_id' },
      `${first} then ${second}`,
    );
    assert.deepEqual(
      rejectionFor(makeLedgerDocument({ fx_rates: [b, a] })),
      { field: 'fx_rates[1].effective_from', rule: 'duplicate_id' },
      `${second} then ${first}`,
    );
  }

  // The tightening is about one instant, not about offsets: two genuinely
  // different moments still coexist however they are written, and a summary
  // built from them is a real one.
  const accepted = validateValueLedger(
    makeLedgerDocument({
      fx_rates: [
        usdRate({ effective_from: '2026-08-01T09:00:00+09:00' }),
        usdRate({ effective_from: '2026-08-01T00:00:00.001Z', to_amount_minor: 20000 }),
      ],
    }),
  );
  assert.ok(accepted.ok, 'a millisecond apart is two instants, not one');
});

test('a cost period is validated, and it is optional', () => {
  const withPeriod = validateValueLedger(
    makeLedgerDocument({
      ai_cost: {
        cost_status: 'finalized',
        amount_minor: 12000,
        currency: 'JPY',
        pricing_source: 'provider_invoice',
        pricing_version: '2026-08',
        period: { ...AUGUST },
      },
    }),
  );
  assert.ok(withPeriod.ok);
  assert.deepEqual(withPeriod.ledger.ai_cost?.period, AUGUST);

  const base = validateValueLedger(makeLedgerDocument());
  assert.ok(base.ok);
  assert.equal(base.ledger.ai_cost?.period, null, 'a ledger written before the ratio layer stands');

  assert.deepEqual(
    rejectionFor(
      makeLedgerDocument({
        ai_cost: {
          cost_status: 'finalized',
          amount_minor: 12000,
          currency: 'JPY',
          pricing_source: 'provider_invoice',
          pricing_version: '2026-08',
          period: { start: AUGUST.end, end: AUGUST.start },
        },
      }),
    ),
    { field: 'ai_cost.period_invalid', rule: 'contract_violation' },
  );
});

// ---------------------------------------------------- mode A is untouched ---

test('mode A keeps currencies apart and converts nothing, even with rates on file', () => {
  const dashboard = dashboardFor(
    makeLedgerDocument({
      // Rates are present but the mode was not changed, so they are inert.
      fx_rates: [usdRate()],
      value_records: [monetaryRecord(), monetaryRecord({ record_id: 'rev-2', unit: 'JPY', quantity: 800000 })],
    }),
  );
  assert.equal(dashboard.aggregation_mode, 'currency_partition');
  assert.deepEqual(dashboard.fx_trace, []);
  assert.deepEqual(dashboard.fx_unconverted, []);

  const revenue = dashboard.sections.find((s) => s.value_metric_type === 'revenue_contribution');
  assert.ok(revenue !== undefined);
  assert.deepEqual(
    revenue.subtotals.map((row) => [row.realization_status, row.unit, row.total]),
    [
      ['realized', 'JPY', 800000],
      ['realized', 'USD', 200000],
    ],
    'two rows, two currencies, never one sum',
  );
  assert.equal(dashboard.costs.ai_cost.fx, null, 'nothing is converted in the partition');
});

// ------------------------------------------------------------- mode B ------

test('mode B publishes one reporting-currency subtotal, with the conversion evidence', () => {
  const dashboard = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      fx_rates: [usdRate()],
      value_records: [monetaryRecord(), monetaryRecord({ record_id: 'rev-2', unit: 'JPY', quantity: 800000 })],
    }),
  );
  assert.equal(dashboard.aggregation_mode, 'reporting_currency_normalized');

  const revenue = dashboard.sections.find((s) => s.value_metric_type === 'revenue_contribution');
  assert.ok(revenue !== undefined);
  assert.deepEqual(
    revenue.subtotals.map((row) => [row.realization_status, row.unit, row.total]),
    [['realized', 'JPY', 1096500]],
    '800,000 + the converted 296,500',
  );

  assert.equal(dashboard.fx_trace.length, 1, 'only the record that was actually converted');
  const trace = dashboard.fx_trace[0];
  assert.ok(trace !== undefined);
  // Everything §7.3.1 makes mandatory for mode B, on the record it applies to.
  assert.equal(trace.record_id, 'rev-1');
  assert.equal(trace.from_currency, 'USD');
  assert.equal(trace.to_currency, 'JPY');
  assert.equal(trace.fx_from_amount_minor, 10000);
  assert.equal(trace.fx_to_amount_minor, 14825);
  assert.equal(trace.fx_rate, '1.482500');
  assert.equal(trace.fx_source, 'published_reference');
  assert.equal(trace.fx_rate_version, '2026-08');
  assert.equal(trace.fx_effective_from, '2026-01-01T00:00:00Z');
  assert.equal(trace.fx_effective_at, AUGUST.end);
  assert.equal(trace.original_amount_minor, 200000, 'the original is kept, not overwritten');
  assert.equal(trace.converted_amount_minor, 296500);
});

test('the rate is resolved at the record window, so a later rate cannot restate it', () => {
  const dashboard = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      fx_rates: [usdRate(), usdRate({ effective_from: '2026-09-01T00:00:00Z', to_amount_minor: 20000 })],
      value_records: [monetaryRecord()],
    }),
  );
  const trace = dashboard.fx_trace[0];
  assert.ok(trace !== undefined);
  assert.equal(trace.fx_to_amount_minor, 14825, 'the September rate does not apply to an August figure');
  assert.equal(trace.fx_effective_to, '2026-09-01T00:00:00Z');
});

test('money with no rate is listed, its subtotal publishes no total, and nothing is zero', () => {
  const dashboard = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      // A EUR figure and no EUR rate anywhere.
      fx_rates: [usdRate()],
      value_records: [
        monetaryRecord({ record_id: 'rev-eur', unit: 'EUR', quantity: 50000 }),
        monetaryRecord({ record_id: 'rev-jpy', unit: 'JPY', quantity: 800000 }),
      ],
    }),
  );

  assert.deepEqual(dashboard.fx_unconverted, [
    { record_id: 'rev-eur', from_currency: 'EUR', to_currency: 'JPY', reason: 'no_applicable_rate' },
  ]);

  const revenue = dashboard.sections.find((s) => s.value_metric_type === 'revenue_contribution');
  assert.ok(revenue !== undefined);
  assert.equal(revenue.record_count, 2, 'the unconverted record is still one of this metric’s');
  assert.equal(revenue.subtotals.length, 1);
  const row = revenue.subtotals[0];
  assert.ok(row !== undefined);
  assert.equal(row.total_blocked, true);
  assert.equal(row.record_count, 2);
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, 'total'),
    false,
    'the converted part alone is not published as the total',
  );
  assert.equal(JSON.stringify(row).includes('800000'), false, 'and it is not published at all');

  // And the ratio built on that numerator refuses too, for the stated reason.
  const realized = dashboard.ratios.filter((entry) => entry.realization_status === 'realized');
  assert.equal(realized.length, 1);
  assert.equal(realized[0]?.ratio_status, 'blocked_currency_mismatch');
});

test('an unconverted amount is never rendered as zero anywhere in the payload', () => {
  const dashboard = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      fx_rates: [],
      value_records: [monetaryRecord({ record_id: 'rev-eur', unit: 'EUR', quantity: 50000 })],
    }),
  );
  const revenue = dashboard.sections.find((s) => s.value_metric_type === 'revenue_contribution');
  assert.ok(revenue !== undefined);
  for (const row of revenue.subtotals) assert.equal(row.total, undefined);
  const text = JSON.stringify(dashboard);
  assert.equal(text.includes('"total":0'), false);
  assert.equal(text.includes('Infinity'), false);
  assert.equal(text.includes('NaN'), false);
});

test('an hourly rate in another currency becomes an estimate mode B can convert', () => {
  // In mode A this record is `unavailable / rate_currency_mismatch`: a USD rate
  // cannot produce a JPY subtotal. In mode B it resolves in USD and the FX
  // layer brings it into JPY - with a rate the operator supplied and dated.
  const document = (mode: string): Record<string, unknown> =>
    makeLedgerDocument({
      aggregation_mode: mode,
      fx_rates: [usdRate()],
      hourly_rates: [
        {
          scope: 'company',
          scope_id: COMPANY,
          effective_from: '2026-01-01T00:00:00Z',
          currency: 'USD',
          basis: 'employee_cost',
          input_method: 'direct',
          hourly_rate_minor: 6000,
          source: 'operator',
        },
      ],
      value_records: [
        {
          record_id: 'ts-aug',
          value_metric_type: 'time_saved',
          value_kind: 'non_monetary',
          realization_status: 'estimated',
          unit: 'minute',
          quantity: 120,
          baseline: { kind: 'manual_process_measurement', quantity: 180 },
          measurement_window: { ...AUGUST },
          attribution_scope: { company_id: COMPANY, department_id: null, user_id: null },
          attribution_method: 'operator_declared',
          confidence: 'medium',
          methodology_version: 'v1',
          evidence_ref: null,
          derived_from: null,
          rate_evidence: null,
        },
      ],
    });

  const partition = dashboardFor(document('currency_partition'));
  assert.deepEqual(partition.unavailable, [
    { source_record_id: 'ts-aug', reason: 'rate_currency_mismatch' },
  ]);
  assert.deepEqual(partition.fx_trace, []);

  const normalized = dashboardFor(document('reporting_currency_normalized'));
  assert.deepEqual(normalized.unavailable, [], 'the estimate is produced');
  assert.equal(normalized.fx_trace.length, 1);
  const proxy = normalized.sections.find((s) => s.value_metric_type === 'time_value_proxy');
  assert.ok(proxy !== undefined);
  // 120 minutes at 60.00 USD/hour is 120.00 USD; at 1.4825 that is 17,790 JPY.
  assert.deepEqual(
    proxy.subtotals.map((row) => [row.unit, row.total]),
    [['JPY', 17790]],
  );
  // The rate trace still names the rate in its own currency: the hourly rate is
  // 60.00 USD, and saying it was JPY would be false.
  assert.equal(normalized.rate_trace[0]?.currency, 'USD');
});

test('a cost bucket is converted too, and a bucket with no period cannot be', () => {
  const withPeriod = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      fx_rates: [usdRate()],
      ai_cost: {
        cost_status: 'finalized',
        amount_minor: 20000,
        currency: 'USD',
        pricing_source: 'provider_invoice',
        pricing_version: '2026-08',
        period: { ...AUGUST },
      },
    }),
  );
  assert.equal(withPeriod.costs.ai_cost.currency, 'JPY');
  assert.equal(withPeriod.costs.ai_cost.amount_minor, 29650);
  const fx = withPeriod.costs.ai_cost.fx;
  assert.ok(fx !== null && fx.status === 'converted');
  assert.equal(fx.original_currency, 'USD');
  assert.equal(fx.original_amount_minor, 20000, 'the billed figure is kept');

  const withoutPeriod = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      fx_rates: [usdRate()],
      ai_cost: {
        cost_status: 'finalized',
        amount_minor: 20000,
        currency: 'USD',
        pricing_source: 'provider_invoice',
        pricing_version: '2026-08',
      },
    }),
  );
  const blocked = withoutPeriod.costs.ai_cost.fx;
  assert.ok(blocked !== null && blocked.status === 'unconverted');
  assert.equal(withoutPeriod.costs.ai_cost.currency, 'USD', 'the original stands');
  assert.equal(withoutPeriod.costs.ai_cost.amount_minor, 20000);
});

test('restriction withholds both amounts of a conversion but keeps its provenance', () => {
  const dashboard = dashboardFor(
    makeLedgerDocument({
      aggregation_mode: 'reporting_currency_normalized',
      fx_rates: [usdRate()],
      value_records: [monetaryRecord()],
    }),
    'restricted',
  );
  const trace = dashboard.fx_trace[0];
  assert.ok(trace !== undefined);
  assert.equal(trace.amount_withheld, true);
  assert.equal(Object.prototype.hasOwnProperty.call(trace, 'original_amount_minor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(trace, 'converted_amount_minor'), false);
  // The rate itself is not this company's money, and without it the trace could
  // not be audited at all.
  assert.equal(trace.fx_rate, '1.482500');
  assert.equal(trace.fx_source, 'published_reference');
  assert.equal(trace.fx_effective_at, AUGUST.end);

  const text = JSON.stringify(dashboard);
  for (const amount of ['200000', '296500']) {
    assert.equal(text.includes(amount), false, amount);
  }
});

// ---------------------------------------------- no new external surface ---

test('the FX path reaches nothing outside this repository', () => {
  // The rates are operator input, like the ledger they arrive in. This is the
  // structural guard on that: none of the three new modules may acquire a
  // network client, a filesystem handle or a clock, in this change or a later
  // one. A rate fetched at an unrecorded moment could not carry the source and
  // effective time §7.3.1 requires anyway.
  for (const file of ['src/domain/fx.ts', 'src/domain/ratio.ts', 'src/domain/decimal.ts']) {
    const source = readFileSync(new URL(file, REPO_ROOT), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*?from '([^']+)';$/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier !== undefined && specifier.startsWith('./'),
        `${file} imports ${specifier ?? '?'}, which is not a sibling domain module`,
      );
    }
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'node:', 'require(', 'Date.now(']) {
      assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
    }
  }
});

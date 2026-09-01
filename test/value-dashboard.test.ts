/**
 * The ROI read model.
 *
 * Two things are being held here: that estimated and realized never end up in
 * the same number, and that withholding an amount is visibly different from
 * reporting zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_COST_LABEL_JA,
  ARK_FEE_LABEL_JA,
  METRIC_LABELS_JA,
  VALUE_DISCLOSURES,
  buildValueDashboard,
  buildValueSummary,
  type ValueDashboard,
  type ValueSection,
} from '../src/domain/valueDashboard.ts';
import { VALUE_METRIC_TYPES, deriveTimeValueProxies, type ValueRecord } from '../src/domain/value.ts';
import { validateValueLedger, valueLedgerStateFrom } from '../src/domain/valueLedger.ts';
import type { ValueLedger } from '../src/domain/valueLedger.ts';
import { DEMO_VALUE_LEDGER } from '../src/demo/valueFixture.ts';
import { COMPANY, makeLedgerDocument, makeMonetary, makePolicy, makeRateEntry, makeTimeSaved } from './valueHelpers.ts';

const AT = '2026-09-01T00:00:00Z';

function ledgerFrom(records: ValueRecord[], overrides: Partial<ValueLedger> = {}): ValueLedger {
  const base = validateValueLedger(makeLedgerDocument());
  assert.ok(base.ok);
  return {
    ...base.ledger,
    rate_policy: makePolicy([makeRateEntry({ scope: 'company', scope_id: COMPANY, hourly_rate_minor: 4000 })], 'v1'),
    records,
    ...overrides,
  };
}

function build(records: ValueRecord[], disclosure: 'restricted' | 'full', overrides: Partial<ValueLedger> = {}) {
  const ledger = ledgerFrom(records, overrides);
  const derivation = deriveTimeValueProxies(ledger.records, ledger.rate_policy);
  return buildValueDashboard({
    ledger,
    records: derivation.records,
    unavailable: derivation.unavailable,
    derivation: { derived: derivation.derived.length, carried_forward: derivation.carried_forward.length },
    disclosure,
    generated_at: AT,
  });
}

function section(dashboard: ValueDashboard, type: (typeof VALUE_METRIC_TYPES)[number]): ValueSection {
  const found = dashboard.sections.find((item) => item.value_metric_type === type);
  assert.ok(found !== undefined, `${type} has a section`);
  return found;
}

test('restricted is a disclosure level, and it is the safe end of the pair', () => {
  assert.deepEqual([...VALUE_DISCLOSURES], ['restricted', 'full']);
});

test('every metric type gets a section, including the ones with no records', () => {
  const dashboard = build([], 'full');
  assert.deepEqual(
    dashboard.sections.map((item) => item.value_metric_type),
    [...VALUE_METRIC_TYPES],
  );
  for (const item of dashboard.sections) {
    assert.equal(item.record_count, 0);
    assert.deepEqual(item.subtotals, [], 'an empty section reports no subtotal, not a zero one');
  }
});

test('the Japanese label for the proxy says 推定 and never claims a saving', () => {
  assert.equal(METRIC_LABELS_JA.time_value_proxy, '創出時間価値（推定）');
  assert.equal(METRIC_LABELS_JA.realized_cost_saving, '実現削減額');
  assert.equal(METRIC_LABELS_JA.time_value_proxy.includes('削減'), false);
});

test('estimated and realized are separate subtotals and are never summed', () => {
  const dashboard = build(
    [
      makeTimeSaved({ record_id: 'ts-1' }),
      makeMonetary({ record_id: 'rc-1', quantity: 150000 }),
      makeMonetary({
        record_id: 'rev-1',
        value_metric_type: 'revenue_contribution',
        realization_status: 'realized',
        quantity: 800000,
      }),
      makeMonetary({
        record_id: 'rev-2',
        value_metric_type: 'revenue_contribution',
        realization_status: 'estimated',
        quantity: 200000,
      }),
    ],
    'full',
  );

  // The proxy is estimated; the realized saving is realized. They are different
  // sections *and* different statuses, so nothing can add them.
  const proxy = section(dashboard, 'time_value_proxy');
  assert.deepEqual(proxy.subtotals, [
    { realization_status: 'estimated', unit: 'JPY', record_count: 1, total: 8000 },
  ]);
  const realized = section(dashboard, 'realized_cost_saving');
  assert.deepEqual(realized.subtotals, [
    { realization_status: 'realized', unit: 'JPY', record_count: 1, total: 150000 },
  ]);

  // Revenue takes both statuses, which is exactly why the subtotal is keyed by
  // status rather than by type.
  const revenue = section(dashboard, 'revenue_contribution');
  assert.deepEqual(revenue.subtotals, [
    { realization_status: 'realized', unit: 'JPY', record_count: 1, total: 800000 },
    { realization_status: 'estimated', unit: 'JPY', record_count: 1, total: 200000 },
  ]);

  // No grand total exists anywhere in the payload.
  assert.equal(Object.prototype.hasOwnProperty.call(dashboard, 'total'), false);
  assert.equal(JSON.stringify(dashboard).includes('"grand_total"'), false);
});

test('monetary subtotals are partitioned by currency and never added across them', () => {
  const dashboard = build(
    [
      makeMonetary({ record_id: 'rc-jpy', quantity: 150000, unit: 'JPY' }),
      makeMonetary({ record_id: 'rc-usd', quantity: 90000, unit: 'USD' }),
    ],
    'full',
  );
  assert.equal(dashboard.aggregation_mode, 'currency_partition');
  assert.deepEqual(section(dashboard, 'realized_cost_saving').subtotals, [
    { realization_status: 'realized', unit: 'JPY', record_count: 1, total: 150000 },
    { realization_status: 'realized', unit: 'USD', record_count: 1, total: 90000 },
  ]);
});

test('restricted withholds every amount, says so, and never emits a zero instead', () => {
  const records = [
    makeTimeSaved({ record_id: 'ts-1' }),
    makeMonetary({ record_id: 'rc-1', quantity: 150000 }),
  ];
  const restricted = build(records, 'restricted');
  assert.equal(restricted.amount_visibility, 'restricted');

  const proxy = section(restricted, 'time_value_proxy');
  assert.deepEqual(proxy.subtotals, [
    { realization_status: 'estimated', unit: 'JPY', record_count: 1, amount_withheld: true },
  ]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(proxy.subtotals[0] ?? {}, 'total'),
    false,
    'the key is absent, not zero',
  );

  // Nothing anywhere in the payload carries a monetary figure.
  const text = JSON.stringify(restricted);
  assert.equal(text.includes('8000'), false, 'the derived amount is gone');
  assert.equal(text.includes('150000'), false, 'and so is the realized one');
  assert.equal(text.includes('4000'), false, 'and the hourly rate itself');
  // The count and the unit stay: withholding a figure is not hiding that it exists.
  assert.ok(text.includes('"record_count":1'));
});

test('non-monetary totals stay visible under restriction: minutes are not money', () => {
  const restricted = build([makeTimeSaved({ record_id: 'ts-1', quantity: 120 })], 'restricted');
  assert.deepEqual(section(restricted, 'time_saved').subtotals, [
    { realization_status: 'estimated', unit: 'minute', record_count: 1, total: 120 },
  ]);
});

test('the rate trace keeps source, currency and period under restriction', () => {
  const records = [makeTimeSaved({ record_id: 'ts-1' })];
  const restricted = build(records, 'restricted');
  const trace = restricted.rate_trace[0];
  assert.ok(trace !== undefined);
  assert.equal(trace.derived_from, 'ts-1');
  assert.equal(trace.resolved_source, 'company');
  assert.equal(trace.currency, 'JPY');
  assert.equal(trace.basis, 'employee_cost');
  assert.equal(trace.effective_from, '2026-01-01T00:00:00Z');
  assert.equal(trace.resolved_at, '2026-05-31T23:59:59Z');
  assert.equal(trace.amount_withheld, true);
  assert.equal(Object.prototype.hasOwnProperty.call(trace, 'hourly_rate_minor'), false);

  const full = build(records, 'full');
  const disclosed = full.rate_trace[0];
  assert.ok(disclosed !== undefined);
  assert.equal(disclosed.hourly_rate_minor, 4000);
  assert.equal(Object.prototype.hasOwnProperty.call(disclosed, 'amount_withheld'), false);
});

test('AI cost and the ARK fee are separate sections that keep their cost_status', () => {
  const dashboard = build([], 'full', {
    ai_cost: {
      cost_status: 'finalized',
      amount_minor: 42000,
      currency: 'JPY',
      pricing_source: 'provider_invoice',
      pricing_version: '2026-08',
      period: null,
    },
    ark_fee: {
      cost_status: 'estimated',
      amount_minor: 30000,
      currency: 'JPY',
      pricing_source: 'contract_rate',
      pricing_version: 'v1',
      period: null,
    },
  });
  assert.equal(dashboard.costs.ai_cost.label, AI_COST_LABEL_JA);
  assert.equal(dashboard.costs.ai_cost.cost_status, 'finalized');
  assert.equal(dashboard.costs.ai_cost.amount_minor, 42000);
  assert.equal(dashboard.costs.ark_fee.label, ARK_FEE_LABEL_JA);
  assert.equal(dashboard.costs.ark_fee.cost_status, 'estimated');
  assert.equal(dashboard.costs.ark_fee.amount_minor, 30000);

  const restricted = build([], 'restricted', {
    ai_cost: {
      cost_status: 'finalized',
      amount_minor: 42000,
      currency: 'JPY',
      pricing_source: 'provider_invoice',
      pricing_version: '2026-08',
      period: null,
    },
  });
  assert.equal(restricted.costs.ai_cost.amount_withheld, true);
  assert.equal(Object.prototype.hasOwnProperty.call(restricted.costs.ai_cost, 'amount_minor'), false);
  assert.equal(restricted.costs.ark_fee.reported, false, 'an unreported bucket is not a zero one');
});

test('unpriced is reported as unpriced, not as an amount and not as withheld', () => {
  const dashboard = build([], 'full', {
    ai_cost: {
      cost_status: 'unpriced',
      amount_minor: null,
      currency: null,
      pricing_source: null,
      pricing_version: null,
      period: null,
    },
  });
  assert.equal(dashboard.costs.ai_cost.cost_status, 'unpriced');
  assert.equal(Object.prototype.hasOwnProperty.call(dashboard.costs.ai_cost, 'amount_minor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dashboard.costs.ai_cost, 'amount_withheld'), false);
});

test('an unresolved rate is listed as unavailable rather than valued at zero', () => {
  const ledger = ledgerFrom([makeTimeSaved({ record_id: 'ts-1' })], {
    // A policy in a currency the ARK default cannot answer for.
    rate_policy: makePolicy([]),
  });
  const derivation = deriveTimeValueProxies(ledger.records, ledger.rate_policy, {
    expected_currency: 'USD',
  });
  const dashboard = buildValueDashboard({
    ledger,
    records: derivation.records,
    unavailable: derivation.unavailable,
    derivation: { derived: 0, carried_forward: 0 },
    disclosure: 'full',
    generated_at: AT,
  });
  assert.deepEqual(dashboard.unavailable, [
    { source_record_id: 'ts-1', reason: 'rate_currency_mismatch' },
  ]);
  assert.deepEqual(section(dashboard, 'time_value_proxy').subtotals, []);
  assert.ok(dashboard.notes.some((note) => note.includes('0円として集計せず')));
});

test('the notes state the separation and the partition in words', () => {
  const dashboard = build([], 'restricted');
  assert.ok(dashboard.notes.some((note) => note.includes('実現削減額')));
  assert.ok(dashboard.notes.some((note) => note.includes('通貨をまたいだ加算はしません')));
  assert.ok(dashboard.notes.some((note) => note.includes('0円という意味ではありません')));
});

// ------------------------------------------------------------- the payload ---

test('the payload reports absent, rejected and accepted distinctly', () => {
  const absent = buildValueSummary({ status: 'absent' }, 'restricted', AT);
  assert.deepEqual(absent, {
    schema_version: 1,
    status: 'absent',
    amount_visibility: 'restricted',
    ledger_source: 'none',
  });

  const rejected = buildValueSummary(
    valueLedgerStateFrom(validateValueLedger({ schema_version: 9 })),
    'full',
    AT,
  );
  assert.equal(rejected.status, 'rejected');
  if (rejected.status !== 'rejected') return;
  assert.equal(rejected.field, 'schema_version');
  assert.equal(rejected.rule, 'unsupported_schema');
  assert.equal(Object.prototype.hasOwnProperty.call(rejected, 'dashboard'), false);
});

test('the summary is deterministic: the same ledger always builds the same payload', () => {
  const state = valueLedgerStateFrom(validateValueLedger(makeLedgerDocument()));
  const first = buildValueSummary(state, 'full', AT);
  const second = buildValueSummary(state, 'full', AT);
  assert.deepEqual(first, second);
});

test('the ledger source is stated so demo money can never read as a real figure', () => {
  const state = valueLedgerStateFrom(validateValueLedger(makeLedgerDocument()));
  assert.equal(buildValueSummary(state, 'full', AT, 'demo_fixture').ledger_source, 'demo_fixture');
  assert.equal(buildValueSummary(state, 'full', AT).ledger_source, 'operator');
});

// -------------------------------------------------------------- the demo ---

test('the DEMO ledger is admissible under the real validator', () => {
  assert.equal(DEMO_VALUE_LEDGER.status, 'accepted');
});

test('the DEMO ledger exercises every branch of the resolution chain', () => {
  const summary = buildValueSummary(DEMO_VALUE_LEDGER, 'full', AT, 'demo_fixture');
  assert.equal(summary.status, 'accepted');
  if (summary.status !== 'accepted') return;
  const sources = summary.dashboard.rate_trace.map((row) => row.resolved_source).sort();
  assert.deepEqual([...new Set(sources)], ['ark_default', 'company', 'department', 'user']);

  // One proxy was already on file and is carried forward at its own old rate.
  assert.equal(summary.dashboard.derivation.carried_forward, 1);
  assert.equal(summary.dashboard.derivation.derived, 4);
  const carried = summary.dashboard.rate_trace.find((row) => row.derived_from === 'tv-carried');
  assert.ok(carried !== undefined);
  assert.equal(carried.hourly_rate_minor, 9000, 'not the 12,000 the policy would resolve today');
});

test('the reporting currency is what a proxy must resolve into, or nothing is published', () => {
  // A USD-reporting ledger with no applicable rate must not be handed the JPY
  // fallback: the subtotal would then be denominated in a currency the operator
  // never chose. The resolver's fail-closed path is what stops it, and this is
  // the shipped call that reaches it.
  const usd = validateValueLedger(
    makeLedgerDocument({ reporting_currency: 'USD', hourly_rates: [] }),
  );
  assert.ok(usd.ok);
  const summary = buildValueSummary({ status: 'accepted', ledger: usd.ledger }, 'full', AT);
  assert.equal(summary.status, 'accepted');
  if (summary.status !== 'accepted') return;

  assert.deepEqual(section(summary.dashboard, 'time_value_proxy').subtotals, []);
  assert.deepEqual(summary.dashboard.unavailable, [
    { source_record_id: 'ts-1', reason: 'rate_currency_mismatch' },
  ]);
  assert.equal(
    JSON.stringify(summary.dashboard.sections).includes('"JPY"'),
    false,
    'no figure appears in a currency the ledger did not choose',
  );

  // A JPY-reporting ledger with the same missing policy still gets the fallback.
  const jpy = validateValueLedger(makeLedgerDocument({ hourly_rates: [] }));
  assert.ok(jpy.ok);
  const ok = buildValueSummary({ status: 'accepted', ledger: jpy.ledger }, 'full', AT);
  assert.equal(ok.status, 'accepted');
  if (ok.status !== 'accepted') return;
  assert.deepEqual(section(ok.dashboard, 'time_value_proxy').subtotals, [
    // 120 minutes at the ARK default of 3,400/hour.
    { realization_status: 'estimated', unit: 'JPY', record_count: 1, total: 6800 },
  ]);
});

test('a rate in a foreign currency is refused rather than substituted', () => {
  const ledger = validateValueLedger(
    makeLedgerDocument({
      hourly_rates: [
        {
          scope: 'company',
          scope_id: COMPANY,
          effective_from: '2026-01-01T00:00:00Z',
          currency: 'USD',
          basis: 'employee_cost',
          input_method: 'direct',
          hourly_rate_minor: 8500,
          source: 'operator',
        },
      ],
    }),
  );
  assert.ok(ledger.ok);
  const summary = buildValueSummary({ status: 'accepted', ledger: ledger.ledger }, 'full', AT);
  assert.equal(summary.status, 'accepted');
  if (summary.status !== 'accepted') return;
  assert.deepEqual(summary.dashboard.unavailable, [
    { source_record_id: 'ts-1', reason: 'rate_currency_mismatch' },
  ]);
});

test('the rate trace names who supplied the winning entry', () => {
  const summary = buildValueSummary(DEMO_VALUE_LEDGER, 'full', AT, 'demo_fixture');
  assert.equal(summary.status, 'accepted');
  if (summary.status !== 'accepted') return;
  for (const row of summary.dashboard.rate_trace) {
    if (row.resolved_source === 'ark_default') assert.equal(row.entry_source, null);
    else assert.equal(row.entry_source, 'operator');
  }
});

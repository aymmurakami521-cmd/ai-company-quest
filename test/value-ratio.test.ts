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
 *
 * Two more properties are pinned further down, and both are about what a *name*
 * is allowed to mean:
 *
 * - under `restricted` the reason itself is withheld whenever the reason states
 *   an amount. A reader who may not see money must not be able to tell a priced
 *   AI cost from one confirmed at exactly 0 - which is what publishing
 *   `undefined_zero_denominator`, or publishing `computed` and letting the zero
 *   case fall out by elimination, would tell them;
 * - `benefit_cost_ratio` is `business_value / ai_cost` and stays that. A future
 *   All-in / TCO indicator is addable *as another name*, and the registry
 *   refuses one that reuses this name or this denominator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AMOUNT_DERIVED_RATIO_STATUSES,
  RATIO_COST_BASES,
  RATIO_STATUSES,
  RATIO_TERM_SETS,
  ratioTermConflicts,
  ratioTermKeys,
  ratioTermsFor,
  type RatioRow,
  type RatioStatus,
} from '../src/domain/ratio.ts';
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

/** Every key name anywhere in a payload, however deeply nested. */
function keyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keyNames(item, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      keyNames(nested, into);
    }
  }
  return into;
}

const PRICED = { value_records: [monetary(), timeSaved()] };
const CONFIRMED_ZERO = { value_records: [monetary(), timeSaved()], ai_cost: cost({ amount_minor: 0 }) };

test('a restricted reader cannot tell a priced AI cost from one confirmed at zero', () => {
  // The whole of the rule, as one assertion. These two ledgers differ only in
  // the AI cost - 42,000 against a confirmed 0 - and a restricted reader is
  // handed the same bytes for both. Any field that told them apart would be the
  // amount, disclosed by another route: 0 is a claim ("this company spent
  // nothing on AI"), not an absence, and it is the figure this ledger is most
  // sensitive about.
  const priced = dashboardFor(PRICED, 'restricted');
  const zero = dashboardFor(CONFIRMED_ZERO, 'restricted');
  assert.deepEqual(zero, priced);
  assert.equal(JSON.stringify(zero), JSON.stringify(priced));
});

test('the same holds when the cost is converted into the reporting currency', () => {
  // Mode B is the path where the cost bucket is restated before it is divided
  // by, so the zero has a second chance to become visible - through the FX
  // trace, the cost section, or a conversion that behaves differently at 0.
  const modeB = (amountMinor: number): Record<string, unknown> => ({
    aggregation_mode: 'reporting_currency_normalized',
    fx_rates: [
      {
        from_currency: 'USD',
        to_currency: 'JPY',
        effective_from: '2026-01-01T00:00:00Z',
        from_amount_minor: 10000,
        to_amount_minor: 14825,
        fx_source: 'published_reference',
        fx_rate_version: '2026-08',
      },
    ],
    value_records: [monetary()],
    ai_cost: cost({ currency: 'USD', amount_minor: amountMinor }),
  });
  const priced = dashboardFor(modeB(30000), 'restricted');
  const zero = dashboardFor(modeB(0), 'restricted');
  assert.deepEqual(zero, priced);
  assert.equal(JSON.stringify(zero), JSON.stringify(priced));
});

test('at full disclosure the two are still told apart, exactly as before', () => {
  // The counterpart of the test above: the restriction is what hides the
  // difference, not the ratio layer forgetting how to see it. Nothing about the
  // disclosed reading changed.
  const priced = rowFor(dashboardFor(PRICED), 'realized');
  const zero = rowFor(dashboardFor(CONFIRMED_ZERO), 'realized');
  assert.equal(priced.ratio_status, 'computed');
  assert.equal(zero.ratio_status, 'undefined_zero_denominator');
});

test('no reason derived from the AI cost figure is published under restriction', () => {
  for (const document of [PRICED, CONFIRMED_ZERO]) {
    const dashboard = dashboardFor(document, 'restricted');
    const text = JSON.stringify(dashboard);
    for (const status of AMOUNT_DERIVED_RATIO_STATUSES) {
      assert.equal(text.includes(status), false, `${status} names a figure`);
    }
    for (const row of dashboard.ratios) {
      assert.equal(row.ratio_status, 'withheld_by_disclosure');
    }
  }
});

test('a withheld ratio row carries a reason and no figure of any kind', () => {
  const dashboard = dashboardFor(PRICED, 'restricted');
  for (const row of dashboard.ratios) {
    assert.equal(row.ratio_status, 'withheld_by_disclosure', 'the restriction is stated on the row');
    // Absent keys, not keys holding 0 or null. §3.3: a withheld figure that
    // renders as 0 is the silent zero this whole layer refuses.
    for (const key of ['benefit_cost_ratio', 'net_roi', 'value_minor', 'cost_minor']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, key), false, key);
    }
    // And not `amount_withheld` either: elsewhere in this payload that key
    // means "a figure exists here and you may not see it", which on a ratio row
    // would itself say the denominator is not 0.
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'amount_withheld'), false);
    // What is left is structure, and it is what makes the row legible: which
    // denominator, which period, how many records, in what currency.
    assert.equal(row.cost_basis, 'ai_cost');
    assert.equal(row.currency, 'JPY');
    assert.equal(row.included_record_count, 1);
    assert.deepEqual(row.period, AUGUST);
  }

  // No amount key survives anywhere in the payload, so none of them can be
  // carrying a 0 - and no non-finite number is standing in for a ratio.
  const keys = keyNames(dashboard);
  for (const key of ['benefit_cost_ratio', 'net_roi', 'value_minor', 'cost_minor', 'amount_minor']) {
    assert.equal(keys.has(key), false, key);
  }
  // `total` survives only on the non-monetary rows - minutes are not money, and
  // they are what keeps 「見せていない」 distinguishable from 「無い」.
  for (const section of dashboard.sections) {
    if (section.value_kind !== 'monetary') continue;
    for (const subtotal of section.subtotals) {
      assert.equal(Object.prototype.hasOwnProperty.call(subtotal, 'total'), false, section.value_metric_type);
    }
  }
  const text = JSON.stringify(dashboard);
  for (const forbidden of ['Infinity', 'NaN', '420000', '42000', '40000', '10.000000', '9.000000']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('the restriction is stated in words, and not as a failure to compute', () => {
  const dashboard = dashboardFor(PRICED, 'restricted');
  // "Why can I not see this" is answered in the same language as the panel.
  assert.ok(
    dashboard.notes.some((note) => note.includes('権限により非表示')),
    JSON.stringify(dashboard.notes),
  );
  assert.ok(dashboard.notes.some((note) => note.includes('0倍という意味でもありません')));
  // And it is not dressed up as a broken ledger: an operator reading this must
  // not go looking for a fault that is not there.
  assert.equal(
    dashboard.notes.some((note) => note.includes('0倍や∞は表示しません')),
    false,
    'nothing here failed to compute',
  );
});

test('a reason that is not about the figure survives restriction untouched', () => {
  // `unpriced` is structural - it is already on `cost_status`, and it is what
  // tells the operator the ledger needs an invoice. Withholding it would
  // withhold the reason without protecting a number.
  const document = {
    value_records: [monetary()],
    ai_cost: { cost_status: 'unpriced', amount_minor: null, currency: null, pricing_source: null },
  };
  const restricted = dashboardFor(document, 'restricted');
  assert.equal(rowFor(restricted, 'realized').ratio_status, 'blocked_unpriced_cost');
  assert.equal(rowFor(restricted, 'realized').ratio_status, rowFor(dashboardFor(document), 'realized').ratio_status);
  assert.ok(restricted.notes.some((note) => note.includes('0倍や∞は表示しません')));
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
    for (const disclosure of ['full', 'restricted'] as const) {
      for (const row of dashboardFor(document, disclosure).ratios) seen.add(row.ratio_status);
    }
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

// ---------------------------------------------- the denominator's name ---

test("the only ratio this build publishes is §8.1's, and every row names its denominator", () => {
  assert.deepEqual([...RATIO_COST_BASES], ['ai_cost'], 'the ARK fee is not a denominator');
  assert.equal(RATIO_TERM_SETS.length, 1, 'no All-in indicator is implemented, only made addable');

  const terms = ratioTermsFor('ai_cost');
  assert.equal(terms.definition, 'business_value / ai_cost');
  assert.equal(terms.ratio_key, 'benefit_cost_ratio');
  assert.equal(terms.net_roi_key, 'net_roi');
  assert.equal(terms.term_en, 'benefit-cost ratio');
  assert.equal(terms.net_term_en, 'net ROI');
  assert.equal(terms.net_label_ja, '純ROI');

  for (const row of dashboardFor({ value_records: [monetary(), timeSaved()] }).ratios) {
    assert.equal(row.cost_basis, 'ai_cost', 'stated on the row, not inferred from which key is present');
  }
});

test('the names the registry declares are the names a computed row actually publishes', () => {
  // Without this the registry would be decoration: a rename on one side could
  // drift from the other, and the collision rule below would then be checking a
  // set of names nothing publishes.
  const realized = rowFor(dashboardFor({ value_records: [monetary()] }), 'realized');
  for (const key of ratioTermKeys(ratioTermsFor('ai_cost'))) {
    assert.equal(Object.prototype.hasOwnProperty.call(realized, key), true, key);
  }
});

test('reporting an ARK fee changes no ratio, because it is not in this denominator', () => {
  const records = [monetary(), timeSaved()];
  const without = dashboardFor({ value_records: records });
  const withFee = dashboardFor({
    value_records: records,
    ark_fee: {
      cost_status: 'estimated',
      amount_minor: 30000,
      currency: 'JPY',
      pricing_source: 'price_list',
      pricing_version: '2026-08',
      period: { ...AUGUST },
    },
  });
  assert.deepEqual(withFee.ratios, without.ratios, '§8.1 is unchanged by a fee being reported');
  assert.equal(withFee.costs.ark_fee.amount_minor, 30000, 'the fee is published, just not divided by');
  assert.equal(without.costs.ark_fee.reported, false);
});

test('a second indicator is addable, but only under its own name and its own denominator', () => {
  // The shape the follow-up would take. Nothing here is registered - this is
  // the *rule* being exercised, and `RATIO_TERM_SETS` still has one member.
  const allIn = {
    cost_basis: 'all_in_cost',
    ratio_key: 'all_in_benefit_cost_ratio',
    net_roi_key: 'all_in_net_roi',
    cost_key: 'all_in_cost_minor',
    term_en: 'all-in benefit-cost ratio',
    label_ja: 'オールイン費用対効果比',
    net_term_en: 'all-in net ROI',
    net_label_ja: 'オールイン純ROI',
  };
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, allIn]), [], 'new names, new denominator: admissible');

  // Reusing the published key is what "the existing ratio keeps its meaning"
  // forbids: two different divisions would answer to `benefit_cost_ratio`.
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, { ...allIn, ratio_key: 'benefit_cost_ratio' }]), [
    'duplicate key: benefit_cost_ratio (ai_cost, all_in_cost)',
  ]);
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, { ...allIn, net_roi_key: 'net_roi' }]), [
    'duplicate key: net_roi (ai_cost, all_in_cost)',
  ]);

  // The name a person reads counts as a name. A second indicator that published
  // its own keys while calling itself 費用対効果比 on screen would rename this
  // one for every human looking at it.
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, { ...allIn, label_ja: '費用対効果比' }]), [
    'duplicate name: 費用対効果比 (ai_cost, all_in_cost)',
  ]);
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, { ...allIn, term_en: 'benefit-cost ratio' }]), [
    'duplicate name: benefit-cost ratio (ai_cost, all_in_cost)',
  ]);
  // The derived term is under the same rule: 純ROI is read off the screen too.
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, { ...allIn, net_label_ja: '純ROI' }]), [
    'duplicate name: 純ROI (ai_cost, all_in_cost)',
  ]);

  // And a second name for the *same* denominator is the duplicate ROI model
  // #41 refuses: an All-in indicator is a different division, not a synonym.
  assert.deepEqual(ratioTermConflicts([...RATIO_TERM_SETS, { ...allIn, cost_basis: 'ai_cost' }]), [
    'duplicate cost_basis: ai_cost',
  ]);
});

test('the shipped registry satisfies its own rules', () => {
  // `ratio.ts` throws at import if this is ever false, so the assertion can
  // only fail by the rules changing under a registry that used to pass - which
  // is exactly the regression worth catching, since the throw itself is
  // unreachable while the registry has one member.
  assert.deepEqual(ratioTermConflicts(RATIO_TERM_SETS), []);
});

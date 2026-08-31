/**
 * The ROI read model.
 *
 * One projection, built once, from an accepted ledger. It is the only shape the
 * server publishes and the only shape the screen renders, so "what is shown" and
 * "what is aggregated" cannot drift apart.
 *
 * Two rules shape everything here.
 *
 * **Estimated and realized never merge.** Subtotals are keyed by
 * `realization_status` *and* currency (`docs/cost-governance-roi-design.md`
 * §7.3.1, aggregation mode A - currency partition, no FX conversion). There is
 * no grand total anywhere in the output, because a grand total is exactly the
 * artefact that lets an estimate be read as money in the bank. In Japanese the
 * proxy is labelled 創出時間価値（推定）for the same reason: 削減額 would claim
 * a cost that stopped being incurred, which is a different fact.
 *
 * **Restricted is not zero.** When amounts are withheld, the amount key is
 * *absent* and `amount_withheld` is true. Emitting 0 instead would be a silent
 * lie of the exact kind §3.3 forbids, and a reader with no permission would see
 * a company that created no value rather than a figure they may not see.
 *
 * That holds for what the *reasons* say too, not only for the figures. A ratio
 * row's reason is withheld exactly when the reason is derived from an amount
 * (`ratio.ts` rule 3), because `undefined_zero_denominator` states an amount -
 * the AI cost is exactly 0 - as plainly as the number would. What is published
 * instead is the restriction itself, so the screen can say why a figure is
 * missing without saying what it was.
 *
 * Pure module: no I/O, no clock, no environment. The `generated_at` instant is
 * passed in.
 */

import { MAX_COST_AMOUNT_MINOR, type CostBucket, type CostStatus, type PricingSource } from './costBucket.ts';
import type {
  RateBasis,
  RateEntrySource,
  RateEvidence,
  RateInputMethod,
  RateResolvedSource,
  RateScope,
} from './rate.ts';
import {
  aggregatedRecord,
  deriveTimeValueProxies,
  MAX_VALUE_QUANTITY_MINOR,
  REALIZATION_STATUSES,
  VALUE_METRIC_RULES,
  VALUE_METRIC_TYPES,
  type AggregatedRecord,
  type MeasurementWindow,
  type RealizationStatus,
  type TimeValueUnavailable,
  type ValueKind,
  type ValueMetricType,
  type ValueRecord,
} from './value.ts';
import {
  convertMinor,
  resolveFxRate,
  type FxEvidence,
  type FxPolicy,
  type FxSource,
  type ValueAggregationMode,
} from './fx.ts';
import { buildRatioRows, type RatioRow } from './ratio.ts';
import type { ValueLedger, ValueLedgerState, ValueRejectRule } from './valueLedger.ts';

/**
 * How much of the money a viewer may see.
 *
 * `restricted` is the default everywhere, including when nothing is configured:
 * a rate policy is commercially sensitive, and a read-only local surface has no
 * identity to check, so the safe answer is to withhold and say so.
 */
export const VALUE_DISCLOSURES = ['restricted', 'full'] as const;
export type ValueDisclosure = (typeof VALUE_DISCLOSURES)[number];

/**
 * Where the figures came from.
 *
 * `demo_fixture` exists so fabricated money can never be mistaken for a
 * company's own: the screen labels it, and a reader never has to work out
 * whether the demo is showing real numbers.
 */
export const VALUE_LEDGER_SOURCES = ['none', 'operator', 'demo_fixture'] as const;
export type ValueLedgerSource = (typeof VALUE_LEDGER_SOURCES)[number];

export const DASHBOARD_SCHEMA_VERSION = 1;

/** Japanese labels. `time_value_proxy` must never read as a realized saving. */
export const METRIC_LABELS_JA: Readonly<Record<ValueMetricType, string>> = {
  time_saved: '削減時間',
  time_value_proxy: '創出時間価値（推定）',
  realized_cost_saving: '実現削減額',
  revenue_contribution: '売上寄与',
  gross_profit_contribution: '粗利寄与',
  quality_error_reduction: '品質・エラー削減',
  response_time_improvement: '対応時間短縮',
  throughput_improvement: '処理件数増加',
};

export const AI_COST_LABEL_JA = 'AI関連コスト';
export const ARK_FEE_LABEL_JA = 'ARK利用料';

/**
 * One subtotal row.
 *
 * `total` carries minutes or counts for a non-monetary metric and is always
 * present - a duration is not commercially sensitive. For a monetary metric it
 * carries minor units and is *omitted* under `restricted`, with
 * `amount_withheld` saying so explicitly.
 */
export type ValueSubtotal = {
  realization_status: RealizationStatus;
  /** ISO 4217 for a monetary row; the non-monetary unit otherwise. */
  unit: string;
  record_count: number;
  total?: number;
  amount_withheld?: true;
  /**
   * Mode B: some of this row's money has no conversion into the reporting
   * currency, so **no total is published for the row at all**.
   *
   * §7.3.1 requires the *subtotal* to fail rather than the record to vanish
   * from it. Publishing the converted part alone would be a total that silently
   * understates itself, which is the same failure as publishing a mixed one -
   * the reader has no way to see that something is missing. The records are
   * still counted here, and each one is named in `fx_unconverted`.
   *
   * Distinct from `amount_withheld`: that one means "there is a total, you may
   * not see it". This one means "there is no total".
   */
  total_blocked?: true;
};

export type ValueSection = {
  value_metric_type: ValueMetricType;
  label: string;
  value_kind: ValueKind;
  record_count: number;
  /** Never folded into one number: one row per (realization_status, unit). */
  subtotals: ValueSubtotal[];
};

export type CostSection = {
  label: string;
  /** False when the ledger reported no such bucket at all. Not the same as 0. */
  reported: boolean;
  cost_status: CostStatus | null;
  /** The currency the published amount is in: the reporting one once converted. */
  currency: string | null;
  pricing_source: PricingSource | null;
  pricing_version: string | null;
  /** The period the operator says the amount covers. Required for a ratio (§8.2). */
  period: MeasurementWindow | null;
  /** Mode B only; null under currency partition, where nothing is converted. */
  fx: CostFx | null;
  amount_minor?: number;
  amount_withheld?: true;
};

/**
 * Why a monetary record could not be brought into the reporting currency.
 * Closed vocabulary. A record listed here is in **no** subtotal - it is not
 * counted as zero, and it is not left in its own currency inside a
 * reporting-currency total (§7.3.1).
 */
export const FX_UNCONVERTED_REASONS = [
  'no_applicable_rate',
  'invalid_request',
  'amount_out_of_range',
] as const;
export type FxUnconvertedReason = (typeof FX_UNCONVERTED_REASONS)[number];

export type FxUnconverted = {
  record_id: string;
  from_currency: string;
  to_currency: string;
  reason: FxUnconvertedReason;
};

/**
 * One line of "which conversion produced this figure": everything §7.3.1 makes
 * mandatory for mode B, per converted record.
 *
 * The rate, its source, its version, its effective period and the direction of
 * the conversion stay readable under every disclosure level, exactly as the
 * hourly rate's provenance does: none of them is this company's money. Only the
 * two amounts - the original and the converted - are withheld.
 */
export type FxTraceRow = {
  record_id: string;
  from_currency: string;
  to_currency: string;
  /**
   * The rate, twice: as the exact rational the operator wrote, and as a
   * fixed-point decimal for reading. The decimal is rounded to six places and a
   * rate like 1/3 is not exact in it, so the pair is what a reader recomputes
   * from.
   *
   * These are legs of a *rate*, not amounts of anybody's money - the `fx_`
   * prefix is there so neither a reader nor a grep confuses them with one - and
   * they stay visible under every disclosure level, like the hourly rate's
   * scope and period do.
   */
  fx_from_amount_minor: number;
  fx_to_amount_minor: number;
  fx_rate: string;
  fx_source: FxSource;
  fx_rate_version: string;
  fx_effective_from: string;
  fx_effective_to: string | null;
  fx_effective_at: string;
  original_amount_minor?: number;
  converted_amount_minor?: number;
  amount_withheld?: true;
};

/**
 * What happened to a cost bucket under mode B. Null in mode A, where nothing is
 * converted at all.
 */
export type CostFx =
  /** Already in the reporting currency; there was nothing to convert. */
  | { status: 'not_required' }
  | {
      status: 'converted';
      evidence: FxEvidence;
      original_currency: string;
      original_amount_minor?: number;
      amount_withheld?: true;
    }
  /** The original amount stands (§4.2); it is simply not commensurate. */
  | { status: 'unconverted'; reason: FxUnconvertedReason; original_currency: string };

/** One line of "which rate produced this estimate, and when was it in force". */
export type RateTraceRow = {
  record_id: string;
  derived_from: string;
  resolved_source: RateResolvedSource;
  /** Who supplied the winning entry; null for the ARK fallback. */
  entry_source: RateEntrySource | null;
  scope: RateScope | null;
  scope_id: string | null;
  currency: string;
  basis: RateBasis;
  input_method: RateInputMethod;
  effective_from: string | null;
  effective_to: string | null;
  resolved_at: string;
  policy_version: string;
  /** Withheld under `restricted`, like every other amount. */
  hourly_rate_minor?: number;
  amount_withheld?: true;
};

export type ValueDashboard = {
  schema_version: number;
  generated_at: string;
  policy_version: string;
  company_id: string;
  reporting_currency: string;
  amount_visibility: ValueDisclosure;
  /**
   * Which of §7.3.1's two subtotal modes produced the figures below, stated in
   * the payload because §8.5 requires the mode to be reported beside them.
   */
  aggregation_mode: ValueAggregationMode;
  measurement_window: MeasurementWindow | null;
  sections: ValueSection[];
  costs: { ai_cost: CostSection; ark_fee: CostSection };
  rate_trace: RateTraceRow[];
  /** One line per converted record. Always empty under currency partition. */
  fx_trace: FxTraceRow[];
  /** Money that has no path to the reporting currency. Never valued at zero. */
  fx_unconverted: FxUnconverted[];
  /** benefit-cost ratio / net ROI, or the reason there is none (§8.4). */
  ratios: RatioRow[];
  /** Time savings that produced no estimate. Counted, never valued at zero. */
  unavailable: TimeValueUnavailable[];
  derivation: { derived: number; carried_forward: number };
  notes: string[];
};

const NOTE_ESTIMATED_SEPARATE =
  '創出時間価値（推定）は estimated です。実現削減額（realized）と同じ合計には入れません。';
const NOTE_CURRENCY_PARTITION =
  '金額小計は realization_status と通貨の組ごとに分けています。通貨をまたいだ加算はしません。';
const NOTE_RESTRICTED = '金額は表示制限中です。0円という意味ではありません。';
const NOTE_UNAVAILABLE =
  '時間単価を解決できなかった削減時間があります。0円として集計せず、未算出として別掲しています。';
const NOTE_FX_NORMALIZED =
  '金額小計は報告通貨へ換算しています。換算した記録ごとに、換算率・出所・版・適用時点・換算方向を保持しています。';
const NOTE_FX_UNCONVERTED =
  '換算率が無い金額があります。0円として集計せず、未換算として別掲しています。';
const NOTE_RATIO_SEPARATE =
  '比率は realization_status ごとに別々に算出しています。推定と実現を1つの比率には混ぜません。';
const NOTE_RATIO_BLOCKED =
  '算出できない比率は理由付きで別掲しています。0倍や∞は表示しません。';
const NOTE_RATIO_WITHHELD =
  '比率は権限により非表示です。算出できなかったという意味でも、0倍という意味でもありません。';

type SubtotalAccumulator = { record_count: number; total: number };

/** Shared empty map for the common case: nothing was blocked. */
const EMPTY_BLOCKED: ReadonlyMap<RealizationStatus, number> = new Map();

/** Buckets keyed by status first, then by unit. No composite string key, so a
 * unit containing the separator could never merge two different buckets. */
type SubtotalBuckets = Map<RealizationStatus, Map<string, SubtotalAccumulator>>;

/**
 * Groups one metric's records into `(realization_status, unit)` buckets.
 *
 * The unit is part of the key even for non-monetary metrics: a ledger may
 * legitimately hold minutes and counts under the same type family, and adding
 * them would produce a number in no unit at all.
 */
function accumulate(records: readonly AggregatedRecord[]): SubtotalBuckets {
  const buckets: SubtotalBuckets = new Map();
  for (const record of records) {
    let byUnit = buckets.get(record.realization_status);
    if (byUnit === undefined) {
      byUnit = new Map<string, SubtotalAccumulator>();
      buckets.set(record.realization_status, byUnit);
    }
    const existing = byUnit.get(record.unit);
    if (existing === undefined) byUnit.set(record.unit, { record_count: 1, total: record.quantity });
    else {
      existing.record_count += 1;
      existing.total += record.quantity;
    }
  }
  return buckets;
}

/**
 * Deterministic order: realized before estimated, then unit ascending.
 *
 * `blocked` names the statuses of this metric that hold money with no path into
 * the reporting currency, together with how many such records there are. Those
 * statuses get exactly one row - in the reporting currency, counting every
 * record, and carrying no total - so a partial figure is never published beside
 * a complete one under the same heading.
 */
function orderedSubtotals(
  buckets: SubtotalBuckets,
  monetary: boolean,
  disclosure: ValueDisclosure,
  blocked: ReadonlyMap<RealizationStatus, number>,
  reportingCurrency: string,
): ValueSubtotal[] {
  const rows: ValueSubtotal[] = [];
  for (const status of REALIZATION_STATUSES) {
    const byUnit = buckets.get(status);
    const blockedCount = blocked.get(status);

    if (blockedCount !== undefined) {
      let counted = blockedCount;
      if (byUnit !== undefined) {
        for (const bucket of byUnit.values()) counted += bucket.record_count;
      }
      const row: ValueSubtotal = {
        realization_status: status,
        unit: reportingCurrency,
        record_count: counted,
        total_blocked: true,
      };
      // Both flags can be true at once, and they say different things: the
      // reader may not see amounts, *and* there is no amount to see.
      if (monetary && disclosure === 'restricted') row.amount_withheld = true;
      rows.push(row);
      continue;
    }

    if (byUnit === undefined) continue;
    for (const unit of [...byUnit.keys()].sort()) {
      const bucket = byUnit.get(unit);
      if (bucket === undefined) continue;
      const row: ValueSubtotal = {
        realization_status: status,
        unit,
        record_count: bucket.record_count,
      };
      if (monetary && disclosure === 'restricted') row.amount_withheld = true;
      else row.total = bucket.total;
      rows.push(row);
    }
  }
  return rows;
}

function costSection(
  label: string,
  bucket: CostBucket | null,
  disclosure: ValueDisclosure,
  fx: CostFx | null,
): CostSection {
  if (bucket === null) {
    return {
      label,
      reported: false,
      cost_status: null,
      currency: null,
      pricing_source: null,
      pricing_version: null,
      period: null,
      fx: null,
    };
  }
  const section: CostSection = {
    label,
    reported: true,
    cost_status: bucket.cost_status,
    currency: bucket.currency,
    pricing_source: bucket.pricing_source,
    pricing_version: bucket.pricing_version,
    period: bucket.period === null ? null : { ...bucket.period },
    fx,
  };
  // `unpriced` has no amount by contract (§3.6), so there is nothing to
  // withhold and nothing to show - the status is the whole statement.
  if (bucket.amount_minor === null) return section;
  if (disclosure === 'restricted') section.amount_withheld = true;
  else section.amount_minor = bucket.amount_minor;
  return section;
}

/**
 * Restates every monetary record into the reporting currency (mode B).
 *
 * Four outcomes per record, and only the first two put anything into a subtotal:
 *
 * 1. non-monetary - untouched. Minutes and counts are not converted, and they
 *    never enter a money subtotal in either mode (§7.1.2).
 * 2. already in the reporting currency - untouched, and *no* trace row: no
 *    conversion happened, so claiming one in the audit trail would be a lie.
 * 3. converted - a trace row records the rate, its source, its version, its
 *    effective period and the direction, and both amounts (§7.3.1).
 * 4. no rate, or a result outside the admissible range - the record is kept out
 *    of every total and listed in `unconverted`. It is *not* added at its
 *    original figure (that is the currency mixing the mode exists to prevent)
 *    and it is *not* added as zero. It is also not simply forgotten: the
 *    subtotal it belonged to publishes no total at all (`total_blocked`),
 *    because §7.3.1 requires the failing subtotal to fail rather than to quietly
 *    shrink.
 *
 * The rate is resolved at each record's own `measurement_window.end`, never at
 * "now". A rate published next quarter has a later `effective_from` and cannot
 * reach back into a figure somebody already read - the same guarantee
 * `rate.ts` gives for the hourly rate.
 */
function normalizeRecords(
  records: readonly ValueRecord[],
  policy: FxPolicy,
  reportingCurrency: string,
  disclosure: ValueDisclosure,
): {
  records: AggregatedRecord[];
  trace: FxTraceRow[];
  unconverted: FxUnconverted[];
  /** The same records as `unconverted`, kept so their subtotals can be blocked. */
  unconverted_records: AggregatedRecord[];
} {
  const out: AggregatedRecord[] = [];
  const trace: FxTraceRow[] = [];
  const unconverted: FxUnconverted[] = [];
  const unconvertedRecords: AggregatedRecord[] = [];

  for (const record of records) {
    const base = aggregatedRecord(record);
    if (record.value_kind !== 'monetary' || record.unit === reportingCurrency) {
      out.push(base);
      continue;
    }

    const resolution = resolveFxRate(policy, {
      from_currency: record.unit,
      to_currency: reportingCurrency,
      at: record.measurement_window.end,
    });
    if (resolution.status !== 'resolved') {
      unconverted.push({
        record_id: record.record_id,
        from_currency: record.unit,
        to_currency: reportingCurrency,
        reason: resolution.reason,
      });
      unconvertedRecords.push(base);
      continue;
    }

    const converted = convertMinor(record.quantity, resolution.evidence, MAX_VALUE_QUANTITY_MINOR);
    if (converted === null) {
      unconverted.push({
        record_id: record.record_id,
        from_currency: record.unit,
        to_currency: reportingCurrency,
        reason: 'amount_out_of_range',
      });
      unconvertedRecords.push(base);
      continue;
    }

    const evidence = resolution.evidence;
    const row: FxTraceRow = {
      record_id: record.record_id,
      from_currency: evidence.from_currency,
      to_currency: evidence.to_currency,
      fx_from_amount_minor: evidence.from_amount_minor,
      fx_to_amount_minor: evidence.to_amount_minor,
      fx_rate: evidence.fx_rate,
      fx_source: evidence.fx_source,
      fx_rate_version: evidence.fx_rate_version,
      fx_effective_from: evidence.fx_effective_from,
      fx_effective_to: evidence.fx_effective_to,
      fx_effective_at: evidence.fx_effective_at,
    };
    if (disclosure === 'restricted') row.amount_withheld = true;
    else {
      row.original_amount_minor = record.quantity;
      row.converted_amount_minor = converted;
    }
    trace.push(row);

    out.push({ ...base, unit: reportingCurrency, quantity: converted });
  }

  return { records: out, trace, unconverted, unconverted_records: unconvertedRecords };
}

/**
 * Restates one cost bucket into the reporting currency (mode B).
 *
 * The bucket is only ever replaced by a converted copy for *display and ratio*
 * purposes; the original currency and amount travel with it in `CostFx` so the
 * figure the provider actually billed is never lost (§4.2).
 *
 * A bucket with no stated period cannot be converted at all: a conversion needs
 * an instant to be dated at, and inventing one - "now", or the span the value
 * records happen to cover - would make the rate applied depend on when the
 * screen was opened.
 */
function convertCostBucket(
  bucket: CostBucket | null,
  policy: FxPolicy,
  reportingCurrency: string,
  disclosure: ValueDisclosure,
): { bucket: CostBucket | null; fx: CostFx | null } {
  if (bucket === null) return { bucket: null, fx: null };
  // `unpriced` carries no amount and no currency by contract (§3.6). There is
  // nothing to convert, and the ratio layer reports it as unpriced regardless.
  if (bucket.amount_minor === null || bucket.currency === null) {
    return { bucket, fx: { status: 'not_required' } };
  }
  if (bucket.currency === reportingCurrency) return { bucket, fx: { status: 'not_required' } };

  if (bucket.period === null) {
    return {
      bucket,
      fx: { status: 'unconverted', reason: 'invalid_request', original_currency: bucket.currency },
    };
  }

  const resolution = resolveFxRate(policy, {
    from_currency: bucket.currency,
    to_currency: reportingCurrency,
    at: bucket.period.end,
  });
  if (resolution.status !== 'resolved') {
    return {
      bucket,
      fx: { status: 'unconverted', reason: resolution.reason, original_currency: bucket.currency },
    };
  }

  const converted = convertMinor(bucket.amount_minor, resolution.evidence, MAX_COST_AMOUNT_MINOR);
  if (converted === null) {
    return {
      bucket,
      fx: {
        status: 'unconverted',
        reason: 'amount_out_of_range',
        original_currency: bucket.currency,
      },
    };
  }

  const fx: CostFx = {
    status: 'converted',
    evidence: resolution.evidence,
    original_currency: bucket.currency,
  };
  if (disclosure === 'restricted') fx.amount_withheld = true;
  else fx.original_amount_minor = bucket.amount_minor;

  return {
    bucket: { ...bucket, amount_minor: converted, currency: reportingCurrency },
    fx,
  };
}

function traceRow(
  record: ValueRecord,
  derivedFrom: string,
  evidence: RateEvidence,
  disclosure: ValueDisclosure,
): RateTraceRow {
  const row: RateTraceRow = {
    record_id: record.record_id,
    derived_from: derivedFrom,
    resolved_source: evidence.resolved_source,
    entry_source: evidence.entry_source,
    scope: evidence.scope,
    scope_id: evidence.scope_id,
    currency: evidence.currency,
    basis: evidence.basis,
    input_method: evidence.input_method,
    effective_from: evidence.effective_from,
    effective_to: evidence.effective_to,
    resolved_at: evidence.resolved_at,
    policy_version: evidence.policy_version,
  };
  // Which rate won, in what currency, and for what period stay visible under
  // every disclosure level: they are the audit trail, and none of them is an
  // amount. Only the rate itself is money.
  if (disclosure === 'restricted') row.amount_withheld = true;
  else row.hourly_rate_minor = evidence.hourly_rate_minor;
  return row;
}

/** The union of every record's window, or null when there are no records. */
function unionWindow(records: readonly { measurement_window: MeasurementWindow }[]): MeasurementWindow | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const record of records) {
    if (start === null || Date.parse(record.measurement_window.start) < Date.parse(start)) {
      start = record.measurement_window.start;
    }
    if (end === null || Date.parse(record.measurement_window.end) > Date.parse(end)) {
      end = record.measurement_window.end;
    }
  }
  return start === null || end === null ? null : { start, end };
}

export type DashboardInput = {
  ledger: ValueLedger;
  /** Every record, derivation already applied. */
  records: readonly ValueRecord[];
  unavailable: readonly TimeValueUnavailable[];
  derivation: { derived: number; carried_forward: number };
  disclosure: ValueDisclosure;
  generated_at: string;
};

/**
 * Builds the ROI read model.
 *
 * Every metric type gets a section, including the ones with no records: an
 * absent section and an empty one are different statements, and a screen that
 * silently drops 実現削減額 when there is none reads as though the concept does
 * not exist.
 */
export function buildValueDashboard(input: DashboardInput): ValueDashboard {
  const { ledger, records, disclosure } = input;
  const mode = ledger.aggregation_mode;
  const normalize = mode === 'reporting_currency_normalized';

  // Mode A is the identity projection: the same records, in their own
  // currencies, with an empty FX trace. Nothing below can tell the difference,
  // which is what keeps the partition path behaving exactly as it did.
  const normalized = normalize
    ? normalizeRecords(records, ledger.fx_policy, ledger.reporting_currency, disclosure)
    : {
        records: records.map(aggregatedRecord),
        trace: [] as FxTraceRow[],
        unconverted: [] as FxUnconverted[],
        unconverted_records: [] as AggregatedRecord[],
      };
  const aggregated = normalized.records;

  const byType = new Map<ValueMetricType, AggregatedRecord[]>();
  for (const type of VALUE_METRIC_TYPES) byType.set(type, []);
  for (const record of aggregated) byType.get(record.value_metric_type)?.push(record);

  // Which `(metric type, realization status)` subtotals hold money that never
  // reached the reporting currency, and which statuses that makes unusable as a
  // ratio numerator. Empty in mode A, where nothing is converted.
  const blockedByType = new Map<ValueMetricType, Map<RealizationStatus, number>>();
  const blockedStatuses = new Set<RealizationStatus>();
  for (const record of normalized.unconverted_records) {
    let byStatus = blockedByType.get(record.value_metric_type);
    if (byStatus === undefined) {
      byStatus = new Map<RealizationStatus, number>();
      blockedByType.set(record.value_metric_type, byStatus);
    }
    byStatus.set(record.realization_status, (byStatus.get(record.realization_status) ?? 0) + 1);
    blockedStatuses.add(record.realization_status);
  }

  const sections: ValueSection[] = [];
  for (const type of VALUE_METRIC_TYPES) {
    const rule = VALUE_METRIC_RULES[type];
    const forType = byType.get(type) ?? [];
    const blocked = blockedByType.get(type) ?? EMPTY_BLOCKED;
    let blockedCount = 0;
    for (const count of blocked.values()) blockedCount += count;
    sections.push({
      value_metric_type: type,
      label: METRIC_LABELS_JA[type],
      value_kind: rule.value_kind,
      // Unconverted records are still this metric's records. Counting only the
      // converted ones would make the section read 記録なし for money that is
      // sitting right there in `fx_unconverted`.
      record_count: forType.length + blockedCount,
      subtotals: orderedSubtotals(
        accumulate(forType),
        rule.value_kind === 'monetary',
        disclosure,
        blocked,
        ledger.reporting_currency,
      ),
    });
  }

  const rateTrace: RateTraceRow[] = [];
  for (const record of records) {
    // A proxy always has both, by contract. Reading them out here rather than
    // defaulting keeps a blank provenance from ever being published.
    if (record.value_metric_type !== 'time_value_proxy') continue;
    if (record.rate_evidence === null || record.derived_from === null) continue;
    rateTrace.push(traceRow(record, record.derived_from, record.rate_evidence, disclosure));
  }
  rateTrace.sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));

  const aiCost = normalize
    ? convertCostBucket(ledger.ai_cost, ledger.fx_policy, ledger.reporting_currency, disclosure)
    : { bucket: ledger.ai_cost, fx: null };
  const arkFee = normalize
    ? convertCostBucket(ledger.ark_fee, ledger.fx_policy, ledger.reporting_currency, disclosure)
    : { bucket: ledger.ark_fee, fx: null };

  // The ARK fee is deliberately not part of the denominator: §8.1 defines the
  // benefit-cost ratio as `business_value / ai_cost`, and folding a platform
  // fee in would publish a different ratio under the same name. An All-in / TCO
  // indicator is therefore a *second* term set in `RATIO_TERM_SETS` producing
  // its own rows, not a wider `ai_cost` passed here - which is why `arkFee`
  // reaches `costs` below and nothing else (`docs/value-rate-design.md` §11.6).
  const ratios = buildRatioRows({
    records: aggregated,
    ai_cost: aiCost.bucket,
    reporting_currency: ledger.reporting_currency,
    mode,
    cost_conversion_failed: aiCost.fx !== null && aiCost.fx.status === 'unconverted',
    blocked_statuses: [...blockedStatuses],
    withhold_amounts: disclosure === 'restricted',
  });

  const notes = [
    NOTE_ESTIMATED_SEPARATE,
    normalize ? NOTE_FX_NORMALIZED : NOTE_CURRENCY_PARTITION,
    NOTE_RATIO_SEPARATE,
  ];
  if (disclosure === 'restricted') notes.push(NOTE_RESTRICTED);
  if (input.unavailable.length > 0) notes.push(NOTE_UNAVAILABLE);
  if (normalized.unconverted.length > 0) notes.push(NOTE_FX_UNCONVERTED);
  // Two different sentences, because they answer two different questions. A
  // row the ledger could not support says so; a row this reader may not see
  // says *that*, and saying "算出できません" instead would send an operator
  // hunting for a fault in a ledger that is fine.
  if (ratios.some((row) => row.ratio_status === 'withheld_by_disclosure')) {
    notes.push(NOTE_RATIO_WITHHELD);
  }
  // Stated as the complement of the two publishable outcomes rather than as a
  // list of refusals, so a reason added to §8.4 later cannot ship with no note.
  if (ratios.some((row) => row.ratio_status !== 'computed' && row.ratio_status !== 'withheld_by_disclosure')) {
    notes.push(NOTE_RATIO_BLOCKED);
  }

  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    generated_at: input.generated_at,
    policy_version: ledger.policy_version,
    company_id: ledger.company_id,
    reporting_currency: ledger.reporting_currency,
    amount_visibility: disclosure,
    aggregation_mode: mode,
    // Over every record the ledger holds, including any that could not be
    // converted: the period the document covers is not narrowed by a missing
    // rate, or a reader would see a shorter window than the data spans.
    measurement_window: unionWindow(records),
    sections,
    costs: {
      ai_cost: costSection(AI_COST_LABEL_JA, aiCost.bucket, disclosure, aiCost.fx),
      ark_fee: costSection(ARK_FEE_LABEL_JA, arkFee.bucket, disclosure, arkFee.fx),
    },
    rate_trace: rateTrace,
    fx_trace: normalized.trace,
    fx_unconverted: normalized.unconverted,
    ratios,
    unavailable: [...input.unavailable],
    derivation: { ...input.derivation },
    notes,
  };
}

/**
 * The published payload, in the same three states the ledger itself has.
 *
 * `amount_visibility` is stated on every branch, including `absent` and
 * `rejected`: a reader must be able to tell "there is nothing" from "there is
 * something you are not being shown" without inferring it from missing keys.
 *
 * A rejected ledger reports a field path and a rule and nothing else. The
 * document that failed contained rates and money, so echoing any part of it
 * back would turn a validation error into a disclosure.
 */
export type ValueSummaryPayload =
  | {
      schema_version: number;
      status: 'absent';
      amount_visibility: ValueDisclosure;
      ledger_source: ValueLedgerSource;
    }
  | {
      schema_version: number;
      status: 'rejected';
      amount_visibility: ValueDisclosure;
      ledger_source: ValueLedgerSource;
      field: string;
      rule: ValueRejectRule;
    }
  | {
      schema_version: number;
      status: 'accepted';
      amount_visibility: ValueDisclosure;
      ledger_source: ValueLedgerSource;
      dashboard: ValueDashboard;
    };

/**
 * Ledger state in, publishable payload out.
 *
 * The derivation runs here rather than at load time so that the stored ledger
 * and the derived view never get confused for one another on disk. It is
 * deterministic: the same ledger and the same `generatedAt` always produce the
 * same payload, and a rate added after a record's measurement window cannot
 * change that record's estimate however many times this runs.
 */
export function buildValueSummary(
  state: ValueLedgerState,
  disclosure: ValueDisclosure,
  generatedAt: string,
  ledgerSource: ValueLedgerSource = 'operator',
): ValueSummaryPayload {
  if (state.status === 'absent') {
    return {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      status: 'absent',
      amount_visibility: disclosure,
      ledger_source: 'none',
    };
  }
  if (state.status === 'rejected') {
    return {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      status: 'rejected',
      amount_visibility: disclosure,
      ledger_source: ledgerSource,
      field: state.field,
      rule: state.rule,
    };
  }

  const ledger = state.ledger;
  // The reporting currency is not decoration: a proxy resolved in some other
  // currency would be published as a subtotal in a currency the operator never
  // chose. Passing it here is what makes the resolver's `currency_mismatch`
  // fail-closed path reachable in the shipped process, so a USD-reporting
  // ledger with no applicable rate reports `unavailable` rather than a JPY
  // figure from the ARK fallback.
  //
  // Under mode B the constraint moves rather than disappearing: the rate may
  // resolve in its own currency, and the FX layer is what brings the resulting
  // estimate into the reporting currency - with a rate the operator supplied,
  // dated, and recorded as evidence. An estimate with no conversion path is
  // still never published in a currency the operator did not choose; it is
  // listed in `fx_unconverted` instead.
  const derivation = deriveTimeValueProxies(ledger.records, ledger.rate_policy, {
    expected_currency:
      ledger.aggregation_mode === 'currency_partition' ? ledger.reporting_currency : null,
  });
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    status: 'accepted',
    amount_visibility: disclosure,
    ledger_source: ledgerSource,
    dashboard: buildValueDashboard({
      ledger,
      records: derivation.records,
      unavailable: derivation.unavailable,
      derivation: {
        derived: derivation.derived.length,
        carried_forward: derivation.carried_forward.length,
      },
      disclosure,
      generated_at: generatedAt,
    }),
  };
}

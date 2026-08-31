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
 * Pure module: no I/O, no clock, no environment. The `generated_at` instant is
 * passed in.
 */

import type { CostBucket, CostStatus, PricingSource } from './costBucket.ts';
import type {
  RateBasis,
  RateEntrySource,
  RateEvidence,
  RateInputMethod,
  RateResolvedSource,
  RateScope,
} from './rate.ts';
import {
  deriveTimeValueProxies,
  REALIZATION_STATUSES,
  VALUE_METRIC_RULES,
  VALUE_METRIC_TYPES,
  type MeasurementWindow,
  type RealizationStatus,
  type TimeValueUnavailable,
  type ValueKind,
  type ValueMetricType,
  type ValueRecord,
} from './value.ts';
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
  currency: string | null;
  pricing_source: PricingSource | null;
  pricing_version: string | null;
  amount_minor?: number;
  amount_withheld?: true;
};

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
  /** Mode A of §7.3.1. No FX conversion happens anywhere in this build. */
  aggregation_mode: 'currency_partition';
  measurement_window: MeasurementWindow | null;
  sections: ValueSection[];
  costs: { ai_cost: CostSection; ark_fee: CostSection };
  rate_trace: RateTraceRow[];
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

type SubtotalAccumulator = { record_count: number; total: number };

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
function accumulate(records: readonly ValueRecord[]): SubtotalBuckets {
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

/** Deterministic order: realized before estimated, then unit ascending. */
function orderedSubtotals(
  buckets: SubtotalBuckets,
  monetary: boolean,
  disclosure: ValueDisclosure,
): ValueSubtotal[] {
  const rows: ValueSubtotal[] = [];
  for (const status of REALIZATION_STATUSES) {
    const byUnit = buckets.get(status);
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

function costSection(label: string, bucket: CostBucket | null, disclosure: ValueDisclosure): CostSection {
  if (bucket === null) {
    return {
      label,
      reported: false,
      cost_status: null,
      currency: null,
      pricing_source: null,
      pricing_version: null,
    };
  }
  const section: CostSection = {
    label,
    reported: true,
    cost_status: bucket.cost_status,
    currency: bucket.currency,
    pricing_source: bucket.pricing_source,
    pricing_version: bucket.pricing_version,
  };
  // `unpriced` has no amount by contract (§3.6), so there is nothing to
  // withhold and nothing to show - the status is the whole statement.
  if (bucket.amount_minor === null) return section;
  if (disclosure === 'restricted') section.amount_withheld = true;
  else section.amount_minor = bucket.amount_minor;
  return section;
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
function unionWindow(records: readonly ValueRecord[]): MeasurementWindow | null {
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

  const byType = new Map<ValueMetricType, ValueRecord[]>();
  for (const type of VALUE_METRIC_TYPES) byType.set(type, []);
  for (const record of records) byType.get(record.value_metric_type)?.push(record);

  const sections: ValueSection[] = [];
  for (const type of VALUE_METRIC_TYPES) {
    const rule = VALUE_METRIC_RULES[type];
    const forType = byType.get(type) ?? [];
    sections.push({
      value_metric_type: type,
      label: METRIC_LABELS_JA[type],
      value_kind: rule.value_kind,
      record_count: forType.length,
      subtotals: orderedSubtotals(accumulate(forType), rule.value_kind === 'monetary', disclosure),
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

  const notes = [NOTE_ESTIMATED_SEPARATE, NOTE_CURRENCY_PARTITION];
  if (disclosure === 'restricted') notes.push(NOTE_RESTRICTED);
  if (input.unavailable.length > 0) notes.push(NOTE_UNAVAILABLE);

  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    generated_at: input.generated_at,
    policy_version: ledger.policy_version,
    company_id: ledger.company_id,
    reporting_currency: ledger.reporting_currency,
    amount_visibility: disclosure,
    aggregation_mode: 'currency_partition',
    measurement_window: unionWindow(records),
    sections,
    costs: {
      ai_cost: costSection(AI_COST_LABEL_JA, ledger.ai_cost, disclosure),
      ark_fee: costSection(ARK_FEE_LABEL_JA, ledger.ark_fee, disclosure),
    },
    rate_trace: rateTrace,
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
  const derivation = deriveTimeValueProxies(ledger.records, ledger.rate_policy, {
    expected_currency: ledger.reporting_currency,
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

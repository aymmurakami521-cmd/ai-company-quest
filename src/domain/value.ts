/**
 * The Business Value contract, in code.
 *
 * This is the existing `docs/cost-governance-roi-design.md` §7 model made
 * executable - not a second ROI model beside it. The type table, the closed
 * vocabularies and every cross-field rule below are that document's, and where
 * the two ever disagree the document is the statement of intent and this file
 * is the enforcement.
 *
 * The three invariants this module exists to make unbreakable:
 *
 * 1. `realization_status` is an axis of its own. It is not derivable from
 *    `value_metric_type` (revenue can be booked or forecast) and not from
 *    `confidence` (a 99%-confident estimate is still an estimate). Subtotals
 *    are keyed by it, so no record can land in two different subtotals
 *    depending on who is reading (§7.1.1).
 * 2. `time_value_proxy` is `estimated`, always. It is a proxy for money that
 *    *might* be freed, not money that was. The type table refuses `realized`
 *    for it, so no code path can promote it into `realized_cost_saving` (§7.3).
 * 3. Converting time into money creates a *new* record. The `time_saved`
 *    observation is never rewritten into a monetary one, so the non-monetary
 *    fact and the monetary estimate stay separately auditable (§7.1.1), and
 *    the estimate carries the exact rate it used (`RateEvidence`) so a later
 *    rate change cannot reach back and restate it.
 *
 * Pure module: no I/O, no clock, no environment.
 */

import {
  isCurrencyCode,
  timeValueMinor,
  MAX_TIME_MINUTES,
  type RateEvidence,
  type RateResolution,
  type HourlyRatePolicy,
  resolveHourlyRate,
} from './rate.ts';

export const VALUE_KINDS = ['monetary', 'non_monetary'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const REALIZATION_STATUSES = ['realized', 'estimated'] as const;
export type RealizationStatus = (typeof REALIZATION_STATUSES)[number];

export const VALUE_METRIC_TYPES = [
  'time_saved',
  'time_value_proxy',
  'realized_cost_saving',
  'revenue_contribution',
  'gross_profit_contribution',
  'quality_error_reduction',
  'response_time_improvement',
  'throughput_improvement',
] as const;
export type ValueMetricType = (typeof VALUE_METRIC_TYPES)[number];

/** Non-monetary units this build understands. Monetary units are ISO 4217 codes. */
export const NON_MONETARY_UNITS = ['minute', 'count', 'ratio_basis_point'] as const;
export type NonMonetaryUnit = (typeof NON_MONETARY_UNITS)[number];

export type ValueMetricRule = {
  readonly value_kind: ValueKind;
  /** The statuses this type may take. `time_value_proxy` gets exactly one. */
  readonly realization_statuses: readonly RealizationStatus[];
  /** Fixed unit, or null when the record chooses (any ISO 4217 code / any unit). */
  readonly unit: NonMonetaryUnit | null;
};

/**
 * `docs/cost-governance-roi-design.md` §7.2, verbatim in structure.
 *
 * The single-element `realization_statuses` on `time_value_proxy` and
 * `realized_cost_saving` is where §7.1.2's two hard constraints live: neither
 * can be expressed by any other combination of fields, so they are refused at
 * admission rather than corrected later.
 */
export const VALUE_METRIC_RULES: Readonly<Record<ValueMetricType, ValueMetricRule>> = {
  time_saved: { value_kind: 'non_monetary', realization_statuses: REALIZATION_STATUSES, unit: 'minute' },
  time_value_proxy: { value_kind: 'monetary', realization_statuses: ['estimated'], unit: null },
  realized_cost_saving: { value_kind: 'monetary', realization_statuses: ['realized'], unit: null },
  revenue_contribution: { value_kind: 'monetary', realization_statuses: REALIZATION_STATUSES, unit: null },
  gross_profit_contribution: { value_kind: 'monetary', realization_statuses: REALIZATION_STATUSES, unit: null },
  quality_error_reduction: { value_kind: 'non_monetary', realization_statuses: REALIZATION_STATUSES, unit: 'count' },
  response_time_improvement: { value_kind: 'non_monetary', realization_statuses: REALIZATION_STATUSES, unit: 'minute' },
  throughput_improvement: { value_kind: 'non_monetary', realization_statuses: REALIZATION_STATUSES, unit: 'count' },
};

/** How the baseline was established. A closed vocabulary, never free text. */
export const BASELINE_KINDS = [
  'manual_process_measurement',
  'prior_period',
  'no_ai_counterfactual',
  'contract_baseline',
  'derived_from_time_saved',
] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

/** How the AI's share of the change was separated out. Closed vocabulary. */
export const ATTRIBUTION_METHODS = [
  'operator_declared',
  'measured_before_after',
  'controlled_comparison',
  'derived_from_time_saved',
] as const;
export type AttributionMethod = (typeof ATTRIBUTION_METHODS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Where the value is booked. Used to refuse cross-scope aggregation (§8.2). */
export type AttributionScope = {
  company_id: string;
  department_id: string | null;
  user_id: string | null;
};

export type MeasurementWindow = { start: string; end: string };

/**
 * One business-value record.
 *
 * `quantity` and `baseline.quantity` are in the record's own `unit`: minor
 * units for a monetary record, whole minutes or counts for a non-monetary one.
 * A baseline is mandatory because a value without one is not a value, it is a
 * number (§7.1).
 */
export type ValueRecord = {
  record_id: string;
  value_metric_type: ValueMetricType;
  value_kind: ValueKind;
  realization_status: RealizationStatus;
  /** ISO 4217 when monetary; one of `NON_MONETARY_UNITS` otherwise. */
  unit: string;
  /** Integer, >= 0. Zero is a legitimate known value; absence is not zero. */
  quantity: number;
  baseline: { kind: BaselineKind; quantity: number };
  measurement_window: MeasurementWindow;
  attribution_scope: AttributionScope;
  attribution_method: AttributionMethod;
  confidence: ConfidenceLevel;
  methodology_version: string;
  evidence_ref: string | null;
  /** `time_value_proxy` only: the `time_saved` record it was derived from. */
  derived_from: string | null;
  /**
   * `time_value_proxy` only, and mandatory there: the rate actually used,
   * frozen. This is what makes "past value is not silently recomputed" a
   * property of the data rather than a promise about future code.
   */
  rate_evidence: RateEvidence | null;
};

/** Why a record is not admissible. Closed vocabulary; carries no record content. */
export const VALUE_RULE_VIOLATIONS = [
  'unknown_metric_type',
  'value_kind_mismatch',
  'realization_status_not_allowed',
  'unit_not_currency',
  'unit_not_allowed',
  'quantity_not_integer',
  'quantity_negative',
  'quantity_out_of_range',
  'baseline_quantity_invalid',
  'saving_exceeds_baseline',
  'measurement_window_invalid',
  'proxy_requires_rate_evidence',
  'proxy_requires_derived_from',
  'proxy_currency_mismatch',
  'rate_evidence_not_allowed',
  'derived_from_not_allowed',
] as const;
export type ValueRuleViolation = (typeof VALUE_RULE_VIOLATIONS)[number];

/**
 * Upper bound on a monetary quantity, in minor units.
 *
 * Chosen so a subtotal of an entire ledger stays exact in a double rather than
 * quietly rounding: the ledger holds at most 4,096 records
 * (`DEFAULT_VALUE_LEDGER_LIMITS.max_value_records`), and 4,096 × 1e12 is
 * 4.096e15, still under `Number.MAX_SAFE_INTEGER` (9.007e15). A larger per
 * record ceiling would let a total silently lose its last digits, which is the
 * one failure a money subtotal must not have.
 */
export const MAX_VALUE_QUANTITY_MINOR = 1_000_000_000_000;

/**
 * Checks one record against the closed contract.
 *
 * Returns every violated rule rather than the first, so a malformed ledger can
 * be corrected in one pass. The rules are the document's; none of them is
 * "corrected" here - a record that breaks one is refused, in line with §3.6's
 * rule that deterministic code never quietly repairs a contract violation.
 */
export function checkValueRecord(record: ValueRecord): ValueRuleViolation[] {
  const violations: ValueRuleViolation[] = [];
  const rule = Object.prototype.hasOwnProperty.call(VALUE_METRIC_RULES, record.value_metric_type)
    ? VALUE_METRIC_RULES[record.value_metric_type]
    : undefined;
  if (rule === undefined) return ['unknown_metric_type'];

  if (record.value_kind !== rule.value_kind) violations.push('value_kind_mismatch');
  if (!rule.realization_statuses.includes(record.realization_status)) {
    violations.push('realization_status_not_allowed');
  }

  if (rule.value_kind === 'monetary') {
    if (!isCurrencyCode(record.unit)) violations.push('unit_not_currency');
  } else if (rule.unit !== null) {
    if (record.unit !== rule.unit) violations.push('unit_not_allowed');
  } else if (!(NON_MONETARY_UNITS as readonly string[]).includes(record.unit)) {
    violations.push('unit_not_allowed');
  }

  const maxQuantity = rule.value_kind === 'monetary' ? MAX_VALUE_QUANTITY_MINOR : MAX_TIME_MINUTES;
  if (!Number.isInteger(record.quantity)) violations.push('quantity_not_integer');
  else if (record.quantity < 0) violations.push('quantity_negative');
  else if (record.quantity > maxQuantity) violations.push('quantity_out_of_range');

  const baseline = record.baseline.quantity;
  if (!Number.isInteger(baseline) || baseline < 0 || baseline > maxQuantity) {
    violations.push('baseline_quantity_invalid');
  } else if (
    (record.value_metric_type === 'time_saved' || record.value_metric_type === 'time_value_proxy') &&
    Number.isInteger(record.quantity) &&
    record.quantity > baseline
  ) {
    // Saving more time than the baseline took is not a large saving, it is a
    // wrong baseline. Accepting it would inflate every downstream estimate.
    violations.push('saving_exceeds_baseline');
  }

  const startMs = Date.parse(record.measurement_window.start);
  const endMs = Date.parse(record.measurement_window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    violations.push('measurement_window_invalid');
  }

  if (record.value_metric_type === 'time_value_proxy') {
    if (record.rate_evidence === null) violations.push('proxy_requires_rate_evidence');
    else if (record.rate_evidence.currency !== record.unit) violations.push('proxy_currency_mismatch');
    if (record.derived_from === null) violations.push('proxy_requires_derived_from');
  } else {
    if (record.rate_evidence !== null) violations.push('rate_evidence_not_allowed');
    if (record.derived_from !== null) violations.push('derived_from_not_allowed');
  }

  return violations;
}

/** Why a `time_saved` record produced no monetary estimate. Never rendered as 0. */
export const TIME_VALUE_UNAVAILABLE_REASONS = [
  'rate_unavailable',
  'rate_currency_mismatch',
  'invalid_rate_request',
  'quantity_out_of_range',
  'proxy_id_conflict',
  'contract_violation',
] as const;
export type TimeValueUnavailableReason = (typeof TIME_VALUE_UNAVAILABLE_REASONS)[number];

export type TimeValueUnavailable = {
  /** The `time_saved` record that could not be converted. */
  source_record_id: string;
  reason: TimeValueUnavailableReason;
};

export type TimeValueDerivation =
  | { status: 'derived'; record: ValueRecord }
  | { status: 'unavailable'; unavailable: TimeValueUnavailable };

/** The id a proxy derived from `sourceId` always takes. Deterministic, so re-runs match. */
export function timeValueProxyId(sourceId: string): string {
  return `${sourceId}#time_value_proxy`;
}

function unavailableFromResolution(sourceId: string, resolution: RateResolution): TimeValueUnavailable {
  if (resolution.status === 'resolved') return { source_record_id: sourceId, reason: 'rate_unavailable' };
  if (resolution.reason === 'currency_mismatch') {
    return { source_record_id: sourceId, reason: 'rate_currency_mismatch' };
  }
  if (resolution.reason === 'invalid_request') {
    return { source_record_id: sourceId, reason: 'invalid_rate_request' };
  }
  return { source_record_id: sourceId, reason: 'rate_unavailable' };
}

/**
 * Turns one `time_saved` observation into one `time_value_proxy` estimate.
 *
 * The rate is resolved at the *end of the record's own measurement window*, not
 * at "now". That is deliberate and is half of the no-retroactive-recomputation
 * guarantee: a rate added next quarter has an `effective_from` after this
 * window, so it cannot win here however often this runs. The other half is that
 * the resolved evidence is written into the record, so even a rate backdated
 * over this window cannot change an estimate that was already produced (see
 * `deriveTimeValueProxies`, which carries existing proxies forward untouched).
 *
 * A rate that cannot be resolved produces `unavailable`, never a zero-yen
 * record. Zero would be indistinguishable from "this hour was genuinely worth
 * nothing", and the whole subtotal would then silently understate itself.
 */
export function deriveTimeValueProxy(
  source: ValueRecord,
  policy: HourlyRatePolicy,
  options: { expected_currency?: string | null } = {},
): TimeValueDerivation {
  if (source.value_metric_type !== 'time_saved' || checkValueRecord(source).length > 0) {
    return { status: 'unavailable', unavailable: { source_record_id: source.record_id, reason: 'contract_violation' } };
  }

  const resolution = resolveHourlyRate(policy, {
    user_id: source.attribution_scope.user_id,
    department_id: source.attribution_scope.department_id,
    company_id: source.attribution_scope.company_id,
    at: source.measurement_window.end,
    expected_currency: options.expected_currency ?? null,
  });
  if (resolution.status !== 'resolved') {
    return { status: 'unavailable', unavailable: unavailableFromResolution(source.record_id, resolution) };
  }

  const evidence = resolution.evidence;
  const quantity = timeValueMinor(evidence.hourly_rate_minor, source.quantity);
  const baseline = timeValueMinor(evidence.hourly_rate_minor, source.baseline.quantity);
  // Two separate ways the product can leave the admissible range: outside the
  // rate/duration ceilings (only reachable with a hand-built policy, since the
  // ledger validator already bounds both), and inside them but past the amount
  // ceiling that keeps a full-ledger subtotal exact. Both are reported as the
  // same thing a reader needs to know - no amount was produced.
  if (
    quantity === null ||
    baseline === null ||
    quantity > MAX_VALUE_QUANTITY_MINOR ||
    baseline > MAX_VALUE_QUANTITY_MINOR
  ) {
    return {
      status: 'unavailable',
      unavailable: { source_record_id: source.record_id, reason: 'quantity_out_of_range' },
    };
  }

  const record: ValueRecord = {
    record_id: timeValueProxyId(source.record_id),
    value_metric_type: 'time_value_proxy',
    value_kind: 'monetary',
    // Not a parameter. The type table allows exactly this, and a caller has no
    // say in it - that is the point of the constraint.
    realization_status: 'estimated',
    unit: evidence.currency,
    quantity,
    baseline: { kind: 'derived_from_time_saved', quantity: baseline },
    measurement_window: { ...source.measurement_window },
    attribution_scope: { ...source.attribution_scope },
    attribution_method: 'derived_from_time_saved',
    // An estimate is never more confident than the observation behind it.
    confidence: source.confidence,
    methodology_version: source.methodology_version,
    evidence_ref: source.evidence_ref,
    derived_from: source.record_id,
    rate_evidence: evidence,
  };

  const violations = checkValueRecord(record);
  if (violations.length > 0) {
    return {
      status: 'unavailable',
      unavailable: { source_record_id: source.record_id, reason: 'contract_violation' },
    };
  }
  return { status: 'derived', record };
}

export type TimeValueDerivationSummary = {
  /** Every record: the inputs, the proxies already on file, and the new ones. */
  records: ValueRecord[];
  /** Ids of proxies that already existed and were left exactly as they were. */
  carried_forward: string[];
  /** Ids of proxies produced by this call. */
  derived: string[];
  unavailable: TimeValueUnavailable[];
};

/**
 * Derives the missing `time_value_proxy` records for a ledger.
 *
 * A proxy already present in the ledger is *never* recomputed, even if the
 * policy would now resolve a different rate: it is carried forward byte for
 * byte, and the source it points at is skipped. This is the enforcement point
 * for "past value is not silently recomputed by a later rate change"
 * (Issue #41 §4) - the stored evidence wins over the current policy, always.
 *
 * Output ordering is deterministic: existing records keep their input order,
 * and new proxies are appended in the order of the sources that produced them.
 */
export function deriveTimeValueProxies(
  records: readonly ValueRecord[],
  policy: HourlyRatePolicy,
  options: { expected_currency?: string | null } = {},
): TimeValueDerivationSummary {
  const alreadyDerived = new Set<string>();
  // `#` is inside the ledger's identifier grammar, so a document may legally
  // declare a record whose id is exactly the one a derivation would mint. The
  // document validator enforces unique ids over what it was given; without this
  // set the derivation could add a second record under an id already in use and
  // silently break that uniqueness downstream.
  const takenIds = new Set<string>();
  for (const record of records) {
    takenIds.add(record.record_id);
    if (record.value_metric_type === 'time_value_proxy' && record.derived_from !== null) {
      alreadyDerived.add(record.derived_from);
    }
  }

  const carriedForward: string[] = [];
  for (const record of records) {
    if (record.value_metric_type === 'time_value_proxy') carriedForward.push(record.record_id);
  }

  const derived: string[] = [];
  const unavailable: TimeValueUnavailable[] = [];
  const produced: ValueRecord[] = [];
  for (const record of records) {
    if (record.value_metric_type !== 'time_saved') continue;
    if (alreadyDerived.has(record.record_id)) continue;
    if (takenIds.has(timeValueProxyId(record.record_id))) {
      unavailable.push({ source_record_id: record.record_id, reason: 'proxy_id_conflict' });
      continue;
    }
    const result = deriveTimeValueProxy(record, policy, options);
    if (result.status === 'derived') {
      produced.push(result.record);
      takenIds.add(result.record.record_id);
      derived.push(result.record.record_id);
    } else {
      unavailable.push(result.unavailable);
    }
  }

  return {
    records: [...records, ...produced],
    carried_forward: carriedForward,
    derived,
    unavailable,
  };
}

/**
 * The amount a stored `time_value_proxy` must carry, given its own evidence and
 * the observation it points at.
 *
 * Exported so the document validator can check that a proxy already on file is
 * consistent with the rate it claims to have used. Without that check, "we
 * already computed this" - which is what stops a later rate edit from restating
 * a figure - would also protect a number nobody ever computed.
 */
export function expectedProxyQuantities(
  source: ValueRecord,
  evidence: RateEvidence,
): { quantity: number; baseline: number } | null {
  const quantity = timeValueMinor(evidence.hourly_rate_minor, source.quantity);
  const baseline = timeValueMinor(evidence.hourly_rate_minor, source.baseline.quantity);
  if (quantity === null || baseline === null) return null;
  return { quantity, baseline };
}

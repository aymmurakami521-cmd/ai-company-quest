/**
 * Value-ledger boundary.
 *
 * Hourly rates and business-value records are *not* stream content, and they
 * are not something the Quest runtime may be told over HTTP. They are operator
 * input on exactly the terms `docs/org-snapshot-design.md` already established
 * for the organisation snapshot: a verified document, supplied by path,
 * validated whole, read once at startup.
 *
 * That choice is the security boundary, not a convenience:
 *
 * - Quest is a read model. Adding a write surface for money would mean adding
 *   the first authenticated, mutating endpoint this process has ever had, on a
 *   server that today answers GET only and holds no identity of any kind. The
 *   Owner/Admin editing surface therefore stays a follow-up with its own auth
 *   boundary (see `docs/value-rate-design.md` §6), and this file is how the
 *   figures get in until it exists.
 * - Because it is configuration, nothing a Claude event ever says can install,
 *   replace or invalidate a rate - the same invariant `player` and `org` have.
 *
 * Guarantees, identical in shape to `org.ts`:
 * - the accepted document is rebuilt key by key from a whitelist, so unknown
 *   producer keys are dropped rather than forwarded;
 * - every surviving string has passed `scanUnsafe`, so an absolute path or a
 *   credential-shaped substring can never reach the ledger;
 * - acceptance is all or nothing: a partial ledger would understate a total,
 *   which is worse than having no total at all;
 * - rejection details name a field path and a rule, never a value - so a
 *   rejected document never leaks the money it contained.
 *
 * This module performs no I/O and reads no environment. It is a pure validator.
 */

import { hasControlChars, scanUnsafe } from './validate.ts';
import { emptyRecord, ownProperty } from './record.ts';
import {
  hourlyRateFromMonthlyCost,
  instantKey,
  isCurrencyCode,
  isIsoInstant,
  MAX_HOURLY_RATE_MINOR,
  MAX_TIME_MINUTES,
  OPERATOR_RATE_BASES,
  OPERATOR_RATE_INPUT_METHODS,
  RATE_BASES,
  RATE_ENTRY_SOURCES,
  RATE_INPUT_METHODS,
  RATE_RESOLVED_SOURCES,
  RATE_SCOPES,
  type HourlyRateEntry,
  type HourlyRatePolicy,
  type RateBasis,
  type RateEntrySource,
  type RateEvidence,
  type RateInputMethod,
  type RateResolvedSource,
  type RateScope,
} from './rate.ts';
import {
  ATTRIBUTION_METHODS,
  BASELINE_KINDS,
  CONFIDENCE_LEVELS,
  checkValueRecord,
  expectedProxyQuantities,
  MAX_VALUE_QUANTITY_MINOR,
  REALIZATION_STATUSES,
  VALUE_KINDS,
  VALUE_METRIC_RULES,
  VALUE_METRIC_TYPES,
  type AttributionMethod,
  type BaselineKind,
  type ConfidenceLevel,
  type MeasurementWindow,
  type RealizationStatus,
  type ValueKind,
  type ValueMetricType,
  type ValueRecord,
} from './value.ts';
import {
  COST_STATUSES,
  PRICING_SOURCES,
  checkCostBucket,
  MAX_COST_AMOUNT_MINOR,
  type CostBucket,
  type CostStatus,
  type PricingSource,
} from './costBucket.ts';
import {
  DEFAULT_VALUE_AGGREGATION_MODE,
  EMPTY_FX_POLICY,
  FX_SOURCES,
  MAX_FX_LEG_MINOR,
  VALUE_AGGREGATION_MODES,
  type FxPolicy,
  type FxRateEntry,
  type FxSource,
  type ValueAggregationMode,
} from './fx.ts';

/** The only ledger contract this build understands. */
export const SUPPORTED_VALUE_LEDGER_SCHEMA_VERSION = 1;

/**
 * Ceilings on the document. Reaching one rejects the ledger only - it never
 * halts ingest, because an oversized ledger says nothing about the health of
 * the event stream.
 */
export type ValueLedgerLimits = {
  max_rate_entries: number;
  max_value_records: number;
  max_fx_rate_entries: number;
};

export const DEFAULT_VALUE_LEDGER_LIMITS: ValueLedgerLimits = {
  max_rate_entries: 512,
  max_value_records: 4096,
  max_fx_rate_entries: 512,
};

/** Identifier grammar for ids the operator writes (company, department, user, records). */
const LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/;
/** Short version labels: `v1`, `2026-08`, `methodology-3`. */
const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ValueRejectRule =
  | 'not_object'
  | 'unsupported_schema'
  | 'missing_key'
  | 'type_error'
  | 'invalid_format'
  | 'control_chars'
  | 'unsafe_content'
  | 'duplicate_id'
  | 'unknown_reference'
  | 'limit_exceeded'
  | 'contract_violation'
  /** The file could not be read at all. Distinct from a document that parsed
   *  and then failed a rule, so a typo'd path and a malformed ledger do not
   *  produce the same startup line. */
  | 'unreadable';

/**
 * The accepted ledger.
 *
 * `records` holds exactly what the document said, with no derivation applied.
 * Deriving `time_value_proxy` records is a separate step (`value.ts`) so that
 * "what the operator stated" and "what we computed from it" never blur.
 */
export type ValueLedger = {
  schema_version: number;
  policy_version: string;
  company_id: string;
  reporting_currency: string;
  /**
   * How money subtotals are built (§7.3.1). Absent in the document means
   * `currency_partition` - mode A, no conversion - so every ledger written
   * before mode B existed keeps behaving exactly as it did.
   */
  aggregation_mode: ValueAggregationMode;
  rate_policy: HourlyRatePolicy;
  /**
   * Operator-supplied conversion rates. Empty unless the document lists them,
   * and consulted only under `reporting_currency_normalized`. No rate in this
   * process ever came from a network call (`fx.ts` module header).
   */
  fx_policy: FxPolicy;
  records: ValueRecord[];
  ai_cost: CostBucket | null;
  ark_fee: CostBucket | null;
};

/**
 * Three states, the same closed vocabulary the organisation input uses.
 * `absent` is not a failure: no ledger configured is a supported mode, and it
 * is reported distinctly from `rejected` so a silent degradation is impossible.
 */
export type ValueLedgerState =
  | { status: 'absent' }
  | { status: 'accepted'; ledger: ValueLedger }
  /** `field` is a path such as `value_records[3].quantity`; indexes, never values. */
  | { status: 'rejected'; field: string; rule: ValueRejectRule };

export const VALUE_LEDGER_ABSENT: ValueLedgerState = { status: 'absent' };

export type ValueLedgerValidation =
  | { ok: true; ledger: ValueLedger; dropped_keys: string[] }
  | { ok: false; field: string; rule: ValueRejectRule };

function reject(field: string, rule: ValueRejectRule): ValueLedgerValidation {
  return { ok: false, field, rule };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

/** Own-property read only, so `__proto__` in the document cannot be inherited. */
function get(raw: Record<string, unknown>, key: string): unknown {
  return hasOwn(raw, key) ? raw[key] : undefined;
}

/**
 * One operator-written string: bounded, control-character free, and clean under
 * the same content scan the event path uses. Every string in this document goes
 * through it, so a ledger can never become a channel for a path or a secret.
 */
function checkText(value: unknown, pattern: RegExp): ValueRejectRule | null {
  if (typeof value !== 'string') return 'type_error';
  if (!pattern.test(value)) return 'invalid_format';
  if (hasControlChars(value)) return 'control_chars';
  if (scanUnsafe(value) !== null) return 'unsafe_content';
  return null;
}

function checkEnum<T extends string>(value: unknown, allowed: readonly T[]): ValueRejectRule | null {
  if (typeof value !== 'string') return 'type_error';
  return (allowed as readonly string[]).includes(value) ? null : 'invalid_format';
}

function checkInstant(value: unknown): ValueRejectRule | null {
  if (typeof value !== 'string') return 'type_error';
  return isIsoInstant(value) ? null : 'invalid_format';
}

/**
 * A non-negative integer inside a stated ceiling.
 *
 * NaN and Infinity fail on `Number.isInteger`, and a negative fails next: the
 * three ways a money field can be nonsense are all refused here rather than
 * being allowed to become a subtotal (Issue #41 §5).
 */
function checkBoundedInteger(value: unknown, max: number): ValueRejectRule | null {
  if (typeof value !== 'number') return 'type_error';
  if (!Number.isInteger(value)) return 'invalid_format';
  if (value < 0 || value > max) return 'invalid_format';
  return null;
}

function requireArray(
  raw: Record<string, unknown>,
  key: string,
  max: number,
): { ok: true; items: unknown[] } | { ok: false; field: string; rule: ValueRejectRule } {
  const value = get(raw, key);
  if (value === undefined) return { ok: false, field: key, rule: 'missing_key' };
  if (!Array.isArray(value)) return { ok: false, field: key, rule: 'type_error' };
  if (value.length > max) return { ok: false, field: key, rule: 'limit_exceeded' };
  return { ok: true, items: value };
}

// ── hourly rate entries ────────────────────────────────────────────────────

type EntryResult = { ok: true; entry: HourlyRateEntry } | { ok: false; field: string; rule: ValueRejectRule };

/**
 * One dated rate.
 *
 * Two input methods are accepted, and they are checked as alternatives rather
 * than as an optional bag of fields: `direct` states the rate, and
 * `calculated_monthly_cost` states the employer-borne monthly cost and the
 * monthly hours. Supplying the wrong pair is refused instead of being partly
 * honoured, so no entry can end up with a rate nobody wrote.
 */
function validateRateEntry(item: unknown, at: string): EntryResult {
  if (!isPlainObject(item)) return { ok: false, field: at, rule: 'type_error' };

  const scopeRule = checkEnum(get(item, 'scope'), RATE_SCOPES);
  if (scopeRule !== null) return { ok: false, field: `${at}.scope`, rule: scopeRule };
  const scope = get(item, 'scope') as RateScope;

  const scopeIdRule = checkText(get(item, 'scope_id'), LEDGER_ID);
  if (scopeIdRule !== null) return { ok: false, field: `${at}.scope_id`, rule: scopeIdRule };
  const scopeId = get(item, 'scope_id') as string;

  const fromRule = checkInstant(get(item, 'effective_from'));
  if (fromRule !== null) return { ok: false, field: `${at}.effective_from`, rule: fromRule };
  const effectiveFrom = get(item, 'effective_from') as string;

  const currency = get(item, 'currency');
  if (typeof currency !== 'string') return { ok: false, field: `${at}.currency`, rule: 'type_error' };
  if (!isCurrencyCode(currency)) return { ok: false, field: `${at}.currency`, rule: 'invalid_format' };

  // `fallback_proxy` is refused here on purpose: it is what the ARK default
  // carries, and an operator entry claiming it would make a declared rate
  // indistinguishable from "nobody told us".
  const basisRule = checkEnum(get(item, 'basis'), OPERATOR_RATE_BASES);
  if (basisRule !== null) return { ok: false, field: `${at}.basis`, rule: basisRule };
  const basis = get(item, 'basis') as RateBasis;

  const methodRule = checkEnum(get(item, 'input_method'), OPERATOR_RATE_INPUT_METHODS);
  if (methodRule !== null) return { ok: false, field: `${at}.input_method`, rule: methodRule };
  const inputMethod = get(item, 'input_method') as RateInputMethod;

  const sourceRule = checkEnum(get(item, 'source'), RATE_ENTRY_SOURCES);
  if (sourceRule !== null) return { ok: false, field: `${at}.source`, rule: sourceRule };
  const source = get(item, 'source') as RateEntrySource;

  let hourlyRateMinor: number;

  if (inputMethod === 'direct') {
    if (hasOwn(item, 'monthly_employer_cost_minor') || hasOwn(item, 'monthly_working_hours')) {
      return { ok: false, field: `${at}.input_method`, rule: 'contract_violation' };
    }
    const value = get(item, 'hourly_rate_minor');
    if (typeof value !== 'number') return { ok: false, field: `${at}.hourly_rate_minor`, rule: 'type_error' };
    // Strictly positive: 0 and NaN are the two ways a rate silently zeroes an
    // entire estimate, and neither is a rate anybody meant to enter.
    if (!Number.isInteger(value) || value <= 0 || value > MAX_HOURLY_RATE_MINOR) {
      return { ok: false, field: `${at}.hourly_rate_minor`, rule: 'invalid_format' };
    }
    hourlyRateMinor = value;
  } else {
    if (hasOwn(item, 'hourly_rate_minor')) {
      return { ok: false, field: `${at}.input_method`, rule: 'contract_violation' };
    }
    const cost = get(item, 'monthly_employer_cost_minor');
    if (typeof cost !== 'number') {
      return { ok: false, field: `${at}.monthly_employer_cost_minor`, rule: 'type_error' };
    }
    const hours = get(item, 'monthly_working_hours');
    if (typeof hours !== 'number') {
      return { ok: false, field: `${at}.monthly_working_hours`, rule: 'type_error' };
    }
    const computed = hourlyRateFromMonthlyCost(cost, hours);
    if (!computed.ok) {
      if (computed.error.startsWith('cost')) {
        return { ok: false, field: `${at}.monthly_employer_cost_minor`, rule: 'invalid_format' };
      }
      if (computed.error.startsWith('hours')) {
        return { ok: false, field: `${at}.monthly_working_hours`, rule: 'invalid_format' };
      }
      // The quotient itself is unusable (it rounds to 0, or overflows). Neither
      // input is individually at fault and the entry carries no
      // `hourly_rate_minor` key to name - a `calculated_monthly_cost` entry is
      // refused for having one - so the entry itself is what failed.
      return { ok: false, field: at, rule: 'contract_violation' };
    }
    hourlyRateMinor = computed.hourly_rate_minor;
  }

  return {
    ok: true,
    entry: {
      scope,
      scope_id: scopeId,
      effective_from: effectiveFrom,
      currency,
      basis,
      input_method: inputMethod,
      hourly_rate_minor: hourlyRateMinor,
      source,
    },
  };
}

// ── FX rate entries ────────────────────────────────────────────────────────

type FxEntryResult =
  | { ok: true; entry: FxRateEntry }
  | { ok: false; field: string; rule: ValueRejectRule };

/**
 * One dated conversion rate.
 *
 * Written as two minor-unit amounts rather than a decimal quote, so applying it
 * never consults a minor-unit exponent table (`fx.ts` module header). Both legs
 * are strictly positive: a zero leg is either an undefined rate or a silent
 * zeroing of every converted amount, and neither is a rate anybody meant.
 */
function validateFxRateEntry(item: unknown, at: string): FxEntryResult {
  if (!isPlainObject(item)) return { ok: false, field: at, rule: 'type_error' };

  const from = get(item, 'from_currency');
  if (typeof from !== 'string') return { ok: false, field: `${at}.from_currency`, rule: 'type_error' };
  if (!isCurrencyCode(from)) return { ok: false, field: `${at}.from_currency`, rule: 'invalid_format' };

  const to = get(item, 'to_currency');
  if (typeof to !== 'string') return { ok: false, field: `${at}.to_currency`, rule: 'type_error' };
  if (!isCurrencyCode(to)) return { ok: false, field: `${at}.to_currency`, rule: 'invalid_format' };

  // An identity "rate" is not a conversion. Accepting one would put a
  // conversion into the audit trail for an amount that was never converted,
  // and a non-1:1 self-rate would be a silent restatement of a currency.
  if (from === to) return { ok: false, field: `${at}.to_currency`, rule: 'contract_violation' };

  const fromRule = checkInstant(get(item, 'effective_from'));
  if (fromRule !== null) return { ok: false, field: `${at}.effective_from`, rule: fromRule };

  const fromAmount = get(item, 'from_amount_minor');
  if (typeof fromAmount !== 'number') {
    return { ok: false, field: `${at}.from_amount_minor`, rule: 'type_error' };
  }
  if (!Number.isInteger(fromAmount) || fromAmount <= 0 || fromAmount > MAX_FX_LEG_MINOR) {
    return { ok: false, field: `${at}.from_amount_minor`, rule: 'invalid_format' };
  }

  const toAmount = get(item, 'to_amount_minor');
  if (typeof toAmount !== 'number') {
    return { ok: false, field: `${at}.to_amount_minor`, rule: 'type_error' };
  }
  if (!Number.isInteger(toAmount) || toAmount <= 0 || toAmount > MAX_FX_LEG_MINOR) {
    return { ok: false, field: `${at}.to_amount_minor`, rule: 'invalid_format' };
  }

  const sourceRule = checkEnum(get(item, 'fx_source'), FX_SOURCES);
  if (sourceRule !== null) return { ok: false, field: `${at}.fx_source`, rule: sourceRule };

  const versionRule = checkText(get(item, 'fx_rate_version'), VERSION_LABEL);
  if (versionRule !== null) return { ok: false, field: `${at}.fx_rate_version`, rule: versionRule };

  return {
    ok: true,
    entry: {
      from_currency: from,
      to_currency: to,
      effective_from: get(item, 'effective_from') as string,
      from_amount_minor: fromAmount,
      to_amount_minor: toAmount,
      fx_source: get(item, 'fx_source') as FxSource,
      fx_rate_version: get(item, 'fx_rate_version') as string,
    },
  };
}

// ── rate evidence carried by an already-derived proxy ──────────────────────

type EvidenceResult = { ok: true; evidence: RateEvidence } | { ok: false; field: string; rule: ValueRejectRule };

/**
 * Validates a stored `rate_evidence` block.
 *
 * These blocks are what stops a rate edit from restating last quarter's
 * figures, so they are checked as strictly as a live entry: an evidence block
 * that is internally inconsistent would let a wrong number persist under the
 * protection of "we already computed this".
 */
function validateRateEvidence(raw: unknown, at: string): EvidenceResult {
  if (!isPlainObject(raw)) return { ok: false, field: at, rule: 'type_error' };

  const sourceRule = checkEnum(get(raw, 'resolved_source'), RATE_RESOLVED_SOURCES);
  if (sourceRule !== null) return { ok: false, field: `${at}.resolved_source`, rule: sourceRule };
  const resolvedSource = get(raw, 'resolved_source') as RateResolvedSource;

  const rawScope = get(raw, 'scope');
  let scope: RateScope | null = null;
  if (rawScope !== null && rawScope !== undefined) {
    const rule = checkEnum(rawScope, RATE_SCOPES);
    if (rule !== null) return { ok: false, field: `${at}.scope`, rule };
    scope = rawScope as RateScope;
  }

  const rawScopeId = get(raw, 'scope_id');
  let scopeId: string | null = null;
  if (rawScopeId !== null && rawScopeId !== undefined) {
    const rule = checkText(rawScopeId, LEDGER_ID);
    if (rule !== null) return { ok: false, field: `${at}.scope_id`, rule };
    scopeId = rawScopeId as string;
  }

  // The fallback belongs to no scope, and a scoped resolution belongs to one.
  // Either mismatch would make the audit trail claim a provenance it does not
  // have, so both are refused.
  const isDefault = resolvedSource === 'ark_default';
  if (isDefault && (scope !== null || scopeId !== null)) {
    return { ok: false, field: `${at}.scope`, rule: 'contract_violation' };
  }
  if (!isDefault && (scope !== resolvedSource || scopeId === null)) {
    return { ok: false, field: `${at}.scope`, rule: 'contract_violation' };
  }

  const rawEntrySource = get(raw, 'entry_source');
  let entrySource: RateEntrySource | null = null;
  if (rawEntrySource !== null && rawEntrySource !== undefined) {
    const rule = checkEnum(rawEntrySource, RATE_ENTRY_SOURCES);
    if (rule !== null) return { ok: false, field: `${at}.entry_source`, rule };
    entrySource = rawEntrySource as RateEntrySource;
  }
  // Nobody supplies the fallback, and a scoped entry always came from somebody.
  if (isDefault !== (entrySource === null)) {
    return { ok: false, field: `${at}.entry_source`, rule: 'contract_violation' };
  }

  const rate = get(raw, 'hourly_rate_minor');
  if (typeof rate !== 'number') return { ok: false, field: `${at}.hourly_rate_minor`, rule: 'type_error' };
  if (!Number.isInteger(rate) || rate <= 0 || rate > MAX_HOURLY_RATE_MINOR) {
    return { ok: false, field: `${at}.hourly_rate_minor`, rule: 'invalid_format' };
  }

  const currency = get(raw, 'currency');
  if (typeof currency !== 'string') return { ok: false, field: `${at}.currency`, rule: 'type_error' };
  if (!isCurrencyCode(currency)) return { ok: false, field: `${at}.currency`, rule: 'invalid_format' };

  const basisRule = checkEnum(get(raw, 'basis'), RATE_BASES);
  if (basisRule !== null) return { ok: false, field: `${at}.basis`, rule: basisRule };
  const methodRule = checkEnum(get(raw, 'input_method'), RATE_INPUT_METHODS);
  if (methodRule !== null) return { ok: false, field: `${at}.input_method`, rule: methodRule };

  const rawFrom = get(raw, 'effective_from');
  let effectiveFrom: string | null = null;
  if (rawFrom !== null && rawFrom !== undefined) {
    const rule = checkInstant(rawFrom);
    if (rule !== null) return { ok: false, field: `${at}.effective_from`, rule };
    effectiveFrom = rawFrom as string;
  }

  const rawTo = get(raw, 'effective_to');
  let effectiveTo: string | null = null;
  if (rawTo !== null && rawTo !== undefined) {
    const rule = checkInstant(rawTo);
    if (rule !== null) return { ok: false, field: `${at}.effective_to`, rule };
    effectiveTo = rawTo as string;
  }
  if (effectiveFrom !== null && effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
    return { ok: false, field: `${at}.effective_to`, rule: 'contract_violation' };
  }

  const resolvedAtRule = checkInstant(get(raw, 'resolved_at'));
  if (resolvedAtRule !== null) return { ok: false, field: `${at}.resolved_at`, rule: resolvedAtRule };

  const policyRule = checkText(get(raw, 'policy_version'), VERSION_LABEL);
  if (policyRule !== null) return { ok: false, field: `${at}.policy_version`, rule: policyRule };

  return {
    ok: true,
    evidence: {
      resolved_source: resolvedSource,
      entry_source: entrySource,
      scope,
      scope_id: scopeId,
      hourly_rate_minor: rate,
      currency,
      basis: get(raw, 'basis') as RateBasis,
      input_method: get(raw, 'input_method') as RateInputMethod,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      resolved_at: get(raw, 'resolved_at') as string,
      policy_version: get(raw, 'policy_version') as string,
    },
  };
}

// ── value records ──────────────────────────────────────────────────────────

type RecordResult = { ok: true; record: ValueRecord } | { ok: false; field: string; rule: ValueRejectRule };

function validateValueRecordObject(item: unknown, at: string, companyId: string): RecordResult {
  if (!isPlainObject(item)) return { ok: false, field: at, rule: 'type_error' };

  const idRule = checkText(get(item, 'record_id'), LEDGER_ID);
  if (idRule !== null) return { ok: false, field: `${at}.record_id`, rule: idRule };

  const typeRule = checkEnum(get(item, 'value_metric_type'), VALUE_METRIC_TYPES);
  if (typeRule !== null) return { ok: false, field: `${at}.value_metric_type`, rule: typeRule };
  const metricType = get(item, 'value_metric_type') as ValueMetricType;

  const kindRule = checkEnum(get(item, 'value_kind'), VALUE_KINDS);
  if (kindRule !== null) return { ok: false, field: `${at}.value_kind`, rule: kindRule };

  const statusRule = checkEnum(get(item, 'realization_status'), REALIZATION_STATUSES);
  if (statusRule !== null) return { ok: false, field: `${at}.realization_status`, rule: statusRule };

  const unit = get(item, 'unit');
  if (typeof unit !== 'string') return { ok: false, field: `${at}.unit`, rule: 'type_error' };
  if (hasControlChars(unit) || scanUnsafe(unit) !== null) {
    return { ok: false, field: `${at}.unit`, rule: 'unsafe_content' };
  }

  const isMonetary = VALUE_METRIC_RULES[metricType].value_kind === 'monetary';
  const maxQuantity = isMonetary ? MAX_VALUE_QUANTITY_MINOR : MAX_TIME_MINUTES;
  const quantityRule = checkBoundedInteger(get(item, 'quantity'), maxQuantity);
  if (quantityRule !== null) return { ok: false, field: `${at}.quantity`, rule: quantityRule };

  const rawBaseline = get(item, 'baseline');
  if (!isPlainObject(rawBaseline)) return { ok: false, field: `${at}.baseline`, rule: 'type_error' };
  const baselineKindRule = checkEnum(get(rawBaseline, 'kind'), BASELINE_KINDS);
  if (baselineKindRule !== null) return { ok: false, field: `${at}.baseline.kind`, rule: baselineKindRule };
  const baselineQuantityRule = checkBoundedInteger(get(rawBaseline, 'quantity'), maxQuantity);
  if (baselineQuantityRule !== null) {
    return { ok: false, field: `${at}.baseline.quantity`, rule: baselineQuantityRule };
  }

  const rawWindow = get(item, 'measurement_window');
  if (!isPlainObject(rawWindow)) return { ok: false, field: `${at}.measurement_window`, rule: 'type_error' };
  const startRule = checkInstant(get(rawWindow, 'start'));
  if (startRule !== null) return { ok: false, field: `${at}.measurement_window.start`, rule: startRule };
  const endRule = checkInstant(get(rawWindow, 'end'));
  if (endRule !== null) return { ok: false, field: `${at}.measurement_window.end`, rule: endRule };

  const rawScope = get(item, 'attribution_scope');
  if (!isPlainObject(rawScope)) return { ok: false, field: `${at}.attribution_scope`, rule: 'type_error' };
  const companyRule = checkText(get(rawScope, 'company_id'), LEDGER_ID);
  if (companyRule !== null) return { ok: false, field: `${at}.attribution_scope.company_id`, rule: companyRule };
  if (get(rawScope, 'company_id') !== companyId) {
    // One ledger, one company. A record booked to somebody else would be
    // aggregated into this company's subtotal and quietly change it (§8.2).
    return { ok: false, field: `${at}.attribution_scope.company_id`, rule: 'unknown_reference' };
  }

  const rawDepartment = get(rawScope, 'department_id');
  let departmentId: string | null = null;
  if (rawDepartment !== null && rawDepartment !== undefined) {
    const rule = checkText(rawDepartment, LEDGER_ID);
    if (rule !== null) return { ok: false, field: `${at}.attribution_scope.department_id`, rule };
    departmentId = rawDepartment as string;
  }

  const rawUser = get(rawScope, 'user_id');
  let userId: string | null = null;
  if (rawUser !== null && rawUser !== undefined) {
    const rule = checkText(rawUser, LEDGER_ID);
    if (rule !== null) return { ok: false, field: `${at}.attribution_scope.user_id`, rule };
    userId = rawUser as string;
  }

  const methodRule = checkEnum(get(item, 'attribution_method'), ATTRIBUTION_METHODS);
  if (methodRule !== null) return { ok: false, field: `${at}.attribution_method`, rule: methodRule };

  const confidenceRule = checkEnum(get(item, 'confidence'), CONFIDENCE_LEVELS);
  if (confidenceRule !== null) return { ok: false, field: `${at}.confidence`, rule: confidenceRule };

  const methodologyRule = checkText(get(item, 'methodology_version'), VERSION_LABEL);
  if (methodologyRule !== null) return { ok: false, field: `${at}.methodology_version`, rule: methodologyRule };

  const rawEvidenceRef = get(item, 'evidence_ref');
  let evidenceRef: string | null = null;
  if (rawEvidenceRef !== null && rawEvidenceRef !== undefined) {
    const rule = checkText(rawEvidenceRef, LEDGER_ID);
    if (rule !== null) return { ok: false, field: `${at}.evidence_ref`, rule };
    evidenceRef = rawEvidenceRef as string;
  }

  const rawDerivedFrom = get(item, 'derived_from');
  let derivedFrom: string | null = null;
  if (rawDerivedFrom !== null && rawDerivedFrom !== undefined) {
    const rule = checkText(rawDerivedFrom, LEDGER_ID);
    if (rule !== null) return { ok: false, field: `${at}.derived_from`, rule };
    derivedFrom = rawDerivedFrom as string;
  }

  const rawEvidence = get(item, 'rate_evidence');
  let rateEvidence: RateEvidence | null = null;
  if (rawEvidence !== null && rawEvidence !== undefined) {
    const result = validateRateEvidence(rawEvidence, `${at}.rate_evidence`);
    if (!result.ok) return result;
    rateEvidence = result.evidence;
  }

  const record: ValueRecord = {
    record_id: get(item, 'record_id') as string,
    value_metric_type: metricType,
    value_kind: get(item, 'value_kind') as ValueKind,
    realization_status: get(item, 'realization_status') as RealizationStatus,
    unit,
    quantity: get(item, 'quantity') as number,
    baseline: {
      kind: get(rawBaseline, 'kind') as BaselineKind,
      quantity: get(rawBaseline, 'quantity') as number,
    },
    measurement_window: {
      start: get(rawWindow, 'start') as string,
      end: get(rawWindow, 'end') as string,
    },
    attribution_scope: { company_id: companyId, department_id: departmentId, user_id: userId },
    attribution_method: get(item, 'attribution_method') as AttributionMethod,
    confidence: get(item, 'confidence') as ConfidenceLevel,
    methodology_version: get(item, 'methodology_version') as string,
    evidence_ref: evidenceRef,
    derived_from: derivedFrom,
    rate_evidence: rateEvidence,
  };

  // The closed cross-field contract (§7.1.2) is checked once, here, by the same
  // function the derivation path uses. There is exactly one definition of an
  // admissible record, so a document cannot express something the code could
  // not have produced.
  const violations = checkValueRecord(record);
  if (violations.length > 0) {
    return { ok: false, field: `${at}.${violations[0] as string}`, rule: 'contract_violation' };
  }
  return { ok: true, record };
}

// ── cost buckets ───────────────────────────────────────────────────────────

type BucketResult = { ok: true; bucket: CostBucket } | { ok: false; field: string; rule: ValueRejectRule };

function validateCostBucket(raw: unknown, at: string): BucketResult {
  if (!isPlainObject(raw)) return { ok: false, field: at, rule: 'type_error' };

  const statusRule = checkEnum(get(raw, 'cost_status'), COST_STATUSES);
  if (statusRule !== null) return { ok: false, field: `${at}.cost_status`, rule: statusRule };

  const rawAmount = get(raw, 'amount_minor');
  let amount: number | null = null;
  if (rawAmount !== null && rawAmount !== undefined) {
    const rule = checkBoundedInteger(rawAmount, MAX_COST_AMOUNT_MINOR);
    if (rule !== null) return { ok: false, field: `${at}.amount_minor`, rule };
    amount = rawAmount as number;
  }

  const rawCurrency = get(raw, 'currency');
  let currency: string | null = null;
  if (rawCurrency !== null && rawCurrency !== undefined) {
    if (typeof rawCurrency !== 'string') return { ok: false, field: `${at}.currency`, rule: 'type_error' };
    if (!isCurrencyCode(rawCurrency)) return { ok: false, field: `${at}.currency`, rule: 'invalid_format' };
    currency = rawCurrency;
  }

  const rawPricingSource = get(raw, 'pricing_source');
  let pricingSource: PricingSource | null = null;
  if (rawPricingSource !== null && rawPricingSource !== undefined) {
    const rule = checkEnum(rawPricingSource, PRICING_SOURCES);
    if (rule !== null) return { ok: false, field: `${at}.pricing_source`, rule };
    pricingSource = rawPricingSource as PricingSource;
  }

  const rawPricingVersion = get(raw, 'pricing_version');
  let pricingVersion: string | null = null;
  if (rawPricingVersion !== null && rawPricingVersion !== undefined) {
    const rule = checkText(rawPricingVersion, VERSION_LABEL);
    if (rule !== null) return { ok: false, field: `${at}.pricing_version`, rule };
    pricingVersion = rawPricingVersion as string;
  }

  // Optional, so a ledger written before the ratio layer existed still
  // validates. Stating it is what makes a benefit-cost ratio admissible
  // (§8.2); leaving it out means the ratio reports `blocked_scope_mismatch`
  // rather than assuming the bucket covers the value records' own window.
  const rawPeriod = get(raw, 'period');
  let period: MeasurementWindow | null = null;
  if (rawPeriod !== null && rawPeriod !== undefined) {
    if (!isPlainObject(rawPeriod)) return { ok: false, field: `${at}.period`, rule: 'type_error' };
    const startRule = checkInstant(get(rawPeriod, 'start'));
    if (startRule !== null) return { ok: false, field: `${at}.period.start`, rule: startRule };
    const endRule = checkInstant(get(rawPeriod, 'end'));
    if (endRule !== null) return { ok: false, field: `${at}.period.end`, rule: endRule };
    period = { start: get(rawPeriod, 'start') as string, end: get(rawPeriod, 'end') as string };
  }

  const bucket: CostBucket = {
    cost_status: get(raw, 'cost_status') as CostStatus,
    amount_minor: amount,
    currency,
    pricing_source: pricingSource,
    pricing_version: pricingVersion,
    period,
  };
  const violations = checkCostBucket(bucket);
  if (violations.length > 0) {
    return { ok: false, field: `${at}.${violations[0] as string}`, rule: 'contract_violation' };
  }
  return { ok: true, bucket };
}

// ── the document ───────────────────────────────────────────────────────────

const KNOWN_KEYS = new Set([
  'schema_version',
  'policy_version',
  'company_id',
  'reporting_currency',
  'aggregation_mode',
  'hourly_rates',
  'fx_rates',
  'value_records',
  'ai_cost',
  'ark_fee',
]);

/** Validates one value ledger, all or nothing. */
export function validateValueLedger(
  raw: unknown,
  limits: ValueLedgerLimits = DEFAULT_VALUE_LEDGER_LIMITS,
): ValueLedgerValidation {
  if (!isPlainObject(raw)) return reject('(root)', 'not_object');

  const schemaVersion = get(raw, 'schema_version');
  if (schemaVersion === undefined) return reject('schema_version', 'missing_key');
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return reject('schema_version', 'type_error');
  }
  if (schemaVersion !== SUPPORTED_VALUE_LEDGER_SCHEMA_VERSION) {
    return reject('schema_version', 'unsupported_schema');
  }

  const policyRule = checkText(get(raw, 'policy_version'), VERSION_LABEL);
  if (policyRule !== null) return reject('policy_version', policyRule);
  const policyVersion = get(raw, 'policy_version') as string;

  const companyRule = checkText(get(raw, 'company_id'), LEDGER_ID);
  if (companyRule !== null) return reject('company_id', companyRule);
  const companyId = get(raw, 'company_id') as string;

  const reportingCurrency = get(raw, 'reporting_currency');
  if (typeof reportingCurrency !== 'string') return reject('reporting_currency', 'type_error');
  if (!isCurrencyCode(reportingCurrency)) return reject('reporting_currency', 'invalid_format');

  // Absent means mode A. The default is stated here rather than inferred from
  // whether `fx_rates` happens to be present: a document that carries rates it
  // does not yet want applied is a legitimate thing to write, and switching
  // modes must be one deliberate key rather than a side effect.
  const rawMode = get(raw, 'aggregation_mode');
  let aggregationMode: ValueAggregationMode = DEFAULT_VALUE_AGGREGATION_MODE;
  if (rawMode !== null && rawMode !== undefined) {
    const rule = checkEnum(rawMode, VALUE_AGGREGATION_MODES);
    if (rule !== null) return reject('aggregation_mode', rule);
    aggregationMode = rawMode as ValueAggregationMode;
  }

  const ratesRaw = requireArray(raw, 'hourly_rates', limits.max_rate_entries);
  if (!ratesRaw.ok) return reject(ratesRaw.field, ratesRaw.rule);
  const entries: HourlyRateEntry[] = [];
  const seenEntries = emptyRecord<true>();
  for (let index = 0; index < ratesRaw.items.length; index += 1) {
    const at = `hourly_rates[${index}]`;
    const result = validateRateEntry(ratesRaw.items[index], at);
    if (!result.ok) return reject(result.field, result.rule);
    const entry = result.entry;
    if (entry.scope === 'company' && entry.scope_id !== companyId) {
      return reject(`${at}.scope_id`, 'unknown_reference');
    }
    // Two entries starting at the same instant for the same scope would make
    // "the rate in force" ambiguous, and the resolver would then depend on
    // document order. Refused rather than tie-broken.
    // The instant is keyed by `instantKey`, not by its text: `00:00:00Z` and
    // `09:00:00+09:00` are one instant written two ways, and comparing the
    // spellings would let both through and hand the tie to array position.
    // `|` is outside `LEDGER_ID`, outside the scope vocabulary and outside an
    // ISO-8601 instant, so no pair of different entries can collide on it.
    const key = `${entry.scope}|${entry.scope_id}|${instantKey(entry.effective_from)}`;
    if (ownProperty(seenEntries, key) !== undefined) return reject(`${at}.effective_from`, 'duplicate_id');
    seenEntries[key] = true;
    entries.push(entry);
  }

  // Optional: mode A never reads it, and a single-currency ledger in mode B
  // needs no rate at all. An absent list is an empty policy, not an error - the
  // failure surfaces per record, at the moment a conversion is actually needed.
  const fxEntries: FxRateEntry[] = [];
  const rawFxRates = get(raw, 'fx_rates');
  if (rawFxRates !== null && rawFxRates !== undefined) {
    if (!Array.isArray(rawFxRates)) return reject('fx_rates', 'type_error');
    if (rawFxRates.length > limits.max_fx_rate_entries) return reject('fx_rates', 'limit_exceeded');
    const seenFx = emptyRecord<true>();
    for (let index = 0; index < rawFxRates.length; index += 1) {
      const at = `fx_rates[${index}]`;
      const result = validateFxRateEntry(rawFxRates[index], at);
      if (!result.ok) return reject(result.field, result.rule);
      const entry = result.entry;
      // Two rates starting at the same instant for the same ordered pair would
      // make "the rate in force" depend on document order. Refused, not
      // tie-broken - the same posture the hourly-rate entries take, down to
      // keying the instant through `instantKey` so that the same moment written
      // with a different offset or a fractional second is still one instant.
      // `|` is outside ISO 4217 and outside an ISO-8601 instant, so no two
      // different entries can collide on this key.
      const key = `${entry.from_currency}|${entry.to_currency}|${instantKey(entry.effective_from)}`;
      if (ownProperty(seenFx, key) !== undefined) return reject(`${at}.effective_from`, 'duplicate_id');
      seenFx[key] = true;
      fxEntries.push(entry);
    }
  }

  const recordsRaw = requireArray(raw, 'value_records', limits.max_value_records);
  if (!recordsRaw.ok) return reject(recordsRaw.field, recordsRaw.rule);
  const records: ValueRecord[] = [];
  const seenRecordIds = emptyRecord<true>();
  const seenDerivedFrom = emptyRecord<true>();
  for (let index = 0; index < recordsRaw.items.length; index += 1) {
    const at = `value_records[${index}]`;
    const result = validateValueRecordObject(recordsRaw.items[index], at, companyId);
    if (!result.ok) return reject(result.field, result.rule);
    const record = result.record;
    if (ownProperty(seenRecordIds, record.record_id) !== undefined) {
      return reject(`${at}.record_id`, 'duplicate_id');
    }
    seenRecordIds[record.record_id] = true;
    if (record.value_metric_type === 'time_value_proxy' && record.derived_from !== null) {
      // Two proxies for one observation would double the estimated subtotal.
      if (ownProperty(seenDerivedFrom, record.derived_from) !== undefined) {
        return reject(`${at}.derived_from`, 'duplicate_id');
      }
      seenDerivedFrom[record.derived_from] = true;
    }
    records.push(record);
  }

  // A proxy already on file is carried forward untouched by the derivation, so
  // its stored amount is what a reader sees for that period, for ever. That
  // protection has to be earned: the record is checked against the observation
  // it points at and the rate it claims to have used. Otherwise "we already
  // computed this" would also shelter a number nobody ever computed.
  const byId = emptyRecord<ValueRecord>();
  for (const record of records) byId[record.record_id] = record;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as ValueRecord;
    if (record.derived_from === null) continue;
    const at = `value_records[${index}]`;
    const source = ownProperty(byId, record.derived_from);
    if (source === undefined) return reject(`${at}.derived_from`, 'unknown_reference');
    if (source.value_metric_type !== 'time_saved') {
      return reject(`${at}.derived_from`, 'contract_violation');
    }
    if (
      source.measurement_window.start !== record.measurement_window.start ||
      source.measurement_window.end !== record.measurement_window.end
    ) {
      return reject(`${at}.measurement_window`, 'contract_violation');
    }
    if (
      source.attribution_scope.company_id !== record.attribution_scope.company_id ||
      source.attribution_scope.department_id !== record.attribution_scope.department_id ||
      source.attribution_scope.user_id !== record.attribution_scope.user_id
    ) {
      return reject(`${at}.attribution_scope`, 'contract_violation');
    }
    // `rate_evidence` is non-null here: `checkValueRecord` already refused a
    // proxy without one.
    const evidence = record.rate_evidence as RateEvidence;
    const expected = expectedProxyQuantities(source, evidence);
    if (expected === null) return reject(`${at}.quantity`, 'contract_violation');
    if (expected.quantity !== record.quantity) return reject(`${at}.quantity`, 'contract_violation');
    if (expected.baseline !== record.baseline.quantity) {
      return reject(`${at}.baseline.quantity`, 'contract_violation');
    }
  }

  let aiCost: CostBucket | null = null;
  const rawAiCost = get(raw, 'ai_cost');
  if (rawAiCost !== null && rawAiCost !== undefined) {
    const result = validateCostBucket(rawAiCost, 'ai_cost');
    if (!result.ok) return reject(result.field, result.rule);
    aiCost = result.bucket;
  }

  let arkFee: CostBucket | null = null;
  const rawArkFee = get(raw, 'ark_fee');
  if (rawArkFee !== null && rawArkFee !== undefined) {
    const result = validateCostBucket(rawArkFee, 'ark_fee');
    if (!result.ok) return reject(result.field, result.rule);
    arkFee = result.bucket;
  }

  const dropped: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) dropped.push(key);
  }

  return {
    ok: true,
    ledger: {
      schema_version: schemaVersion,
      policy_version: policyVersion,
      company_id: companyId,
      reporting_currency: reportingCurrency,
      aggregation_mode: aggregationMode,
      rate_policy: { policy_version: policyVersion, entries },
      fx_policy: fxEntries.length === 0 ? EMPTY_FX_POLICY : { entries: fxEntries },
      records,
      ai_cost: aiCost,
      ark_fee: arkFee,
    },
    dropped_keys: dropped,
  };
}

/** Folds a validation result into the closed three-state vocabulary. */
export function valueLedgerStateFrom(result: ValueLedgerValidation): ValueLedgerState {
  if (result.ok) return { status: 'accepted', ledger: result.ledger };
  return { status: 'rejected', field: result.field, rule: result.rule };
}

/** Sanitized one-line detail for logs: field path and rule only, never a value. */
export function valueLedgerStatusDetail(state: ValueLedgerState): string {
  if (state.status === 'accepted') return 'accepted';
  if (state.status === 'absent') return 'absent';
  return `rejected:${state.field}:${state.rule}`;
}

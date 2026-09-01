/**
 * Hourly-rate policy and resolution.
 *
 * This is the money side of `time_value_proxy`, and nothing else. It is a pure
 * module: no I/O, no clock, no environment. Given a policy and a request it
 * answers *which* rate applies, *why* that one, and *when* it was in force -
 * or it answers `unavailable`, which is a different thing from zero.
 *
 * Contract this module implements (`docs/cost-governance-roi-design.md` §7):
 *
 * - The resolution order is fixed and total: `user > department > company >
 *   ARK default`. It is not configurable, because a per-tenant order would make
 *   two identical value records resolve differently and silently.
 * - The ARK default (3,400 JPY/hour) is a *fallback proxy*. It is deliberately
 *   not `employee_cost` and not `time_value`: calling it either would assert a
 *   salary or an opportunity cost that nobody declared. It carries its own
 *   basis so a reader can always tell "nobody told us" from "somebody did".
 * - A missing rate is never 0. §3.3 already forbids inventing a dimension, and
 *   0 is a *known* amount - "this hour was worth nothing" - not an absence. So
 *   an unresolvable request returns `unavailable` with a closed-vocabulary
 *   reason and the caller declines to produce a value record at all.
 * - A currency the caller did not expect fails closed rather than falling
 *   through to the next scope. Falling through would substitute a different
 *   person's rate for a currency mismatch, which is a silent re-attribution.
 *
 * Amounts are integers in the currency's *minor units* throughout. Money as a
 * float would make `0.1` hours × a rate depend on IEEE-754 rounding, and two
 * runs of the same fold could then disagree in the last digit; the whole point
 * of this repository's reducer is that they cannot.
 */

/** Scopes an operator can attach a rate to. Order here is not the resolution order. */
export const RATE_SCOPES = ['company', 'department', 'user'] as const;
export type RateScope = (typeof RATE_SCOPES)[number];

/**
 * The fixed resolution order, most specific first. The ARK default is not in
 * this list because it is not a scope an operator can write to - it is what is
 * left when every scope missed.
 */
export const RATE_RESOLUTION_ORDER: readonly RateScope[] = ['user', 'department', 'company'];

/** Where the resolved rate came from. `ark_default` is always the last resort. */
export const RATE_RESOLVED_SOURCES = ['user', 'department', 'company', 'ark_default'] as const;
export type RateResolvedSource = (typeof RATE_RESOLVED_SOURCES)[number];

/**
 * What the number *means*. Kept separate on purpose (Issue #41 §2): an employer
 * cost and an owner's opportunity cost are not interchangeable, and collapsing
 * them would let a sole proprietor's time value be reported as payroll.
 */
export const RATE_BASES = ['employee_cost', 'time_value', 'fallback_proxy'] as const;
export type RateBasis = (typeof RATE_BASES)[number];

/** The bases an operator may declare. `fallback_proxy` is reserved for the default. */
export const OPERATOR_RATE_BASES: readonly RateBasis[] = ['employee_cost', 'time_value'];

/** How the operator arrived at the number. */
export const RATE_INPUT_METHODS = ['direct', 'calculated_monthly_cost', 'ark_default'] as const;
export type RateInputMethod = (typeof RATE_INPUT_METHODS)[number];

/** The input methods an operator may declare. `ark_default` is reserved. */
export const OPERATOR_RATE_INPUT_METHODS: readonly RateInputMethod[] = [
  'direct',
  'calculated_monthly_cost',
];

/** Who supplied the entry. A closed vocabulary, never free text. */
export const RATE_ENTRY_SOURCES = ['operator', 'company_brain'] as const;
export type RateEntrySource = (typeof RATE_ENTRY_SOURCES)[number];

/**
 * Ceilings. They exist so `hourly_rate_minor × minutes` stays inside
 * `Number.MAX_SAFE_INTEGER` (1e8 × 1e7 = 1e15 < 9.007e15), which is what lets
 * the proxy be computed in exact integer arithmetic instead of floating point.
 */
export const MAX_HOURLY_RATE_MINOR = 100_000_000;
export const MAX_TIME_MINUTES = 10_000_000;
/** 31 days × 24 hours. Anything past it is a typo, not a working month. */
export const MAX_MONTHLY_WORKING_HOURS = 744;
export const MAX_MONTHLY_COST_MINOR = 10_000_000_000;

/** ISO 4217 shape. The list itself is not enumerable here; the shape is the gate. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE.test(value);
}

/**
 * Minor-unit exponents for the currencies this build formats. Anything absent
 * is formatted with 2, which is the ISO 4217 default. This table decides
 * *display* only - arithmetic is always on minor units.
 *
 * Exported so `test/ui-value.test.ts` can compare it *both ways* against the
 * browser's copy in `quest-value.js`. A one-directional check would miss a
 * currency added here and not there, which would then render with the wrong
 * number of decimals.
 */
export const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

export function minorUnitExponent(currency: string): number {
  return Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENTS, currency)
    ? (MINOR_UNIT_EXPONENTS[currency] as number)
    : 2;
}

/**
 * The Japanese ARK fallback: 3,400 JPY per hour. JPY has no minor unit, so the
 * minor-unit amount and the displayed amount coincide - that is a property of
 * the currency, not an assumption baked into the number.
 *
 * This is a *proxy for a missing input*, not a salary, not a billing rate and
 * not a claim about anybody's worth. It exists so that a tenant who configured
 * nothing still gets an auditable, clearly-labelled estimate instead of a
 * silent zero.
 */
export const ARK_DEFAULT_HOURLY_RATE_MINOR = 3400;
export const ARK_DEFAULT_CURRENCY = 'JPY';

/** One dated rate for one scope. Already validated; see `valueLedger.ts`. */
export type HourlyRateEntry = {
  scope: RateScope;
  scope_id: string;
  /** ISO-8601 instant. The entry applies from here until the next one starts. */
  effective_from: string;
  currency: string;
  basis: RateBasis;
  input_method: RateInputMethod;
  /** Integer, minor units, strictly positive. Never 0, never NaN. */
  hourly_rate_minor: number;
  source: RateEntrySource;
};

/**
 * The employer-borne monthly cost an operator may type is deliberately *not*
 * retained. `input_method` already records which of the two forms was used, and
 * the operator's own document remains the record of the arithmetic; holding the
 * monthly figure in process memory would keep a more sensitive number than the
 * hourly rate it produced, for no reader (Issue #41 §2).
 */

/** A rate policy is just its entries; ordering is imposed at resolution time. */
export type HourlyRatePolicy = {
  /** Version of the policy document these entries came from. Carried into evidence. */
  policy_version: string;
  entries: readonly HourlyRateEntry[];
};

/**
 * Exactly what was used, frozen at the moment of use.
 *
 * This is the mechanism behind "past value is never silently recomputed"
 * (Issue #41 §4): a derived value record keeps this object, so a rate edited
 * next month cannot reach backwards and change a number somebody already read.
 * Everything a reader needs to audit the figure is here - the amount, the
 * currency, which scope won, what the number means, how it was entered, and
 * the window during which it was in force.
 */
export type RateEvidence = {
  resolved_source: RateResolvedSource;
  /**
   * Who supplied the winning entry. Null for `ark_default`, which nobody
   * supplied. Kept apart from `resolved_source`: one says *which scope* won,
   * this says *where that scope's number came from* - both are named as history
   * fields by Issue #41 §4.
   */
  entry_source: RateEntrySource | null;
  /** Null for `ark_default`: the fallback belongs to no scope. */
  scope: RateScope | null;
  scope_id: string | null;
  hourly_rate_minor: number;
  currency: string;
  basis: RateBasis;
  input_method: RateInputMethod;
  /** Null for `ark_default`, which has no start date. */
  effective_from: string | null;
  /** The next entry's `effective_from` in the same scope, or null while open-ended. */
  effective_to: string | null;
  /** The instant the policy was evaluated *against* - not the wall clock. */
  resolved_at: string;
  policy_version: string;
};

/** Why no rate could be produced. Closed vocabulary; never a free-text reason. */
export const RATE_UNAVAILABLE_REASONS = [
  'no_applicable_rate',
  'currency_mismatch',
  'invalid_request',
] as const;
export type RateUnavailableReason = (typeof RATE_UNAVAILABLE_REASONS)[number];

export type RateResolution =
  | { status: 'resolved'; evidence: RateEvidence }
  | { status: 'unavailable'; reason: RateUnavailableReason };

export type RateRequest = {
  user_id: string | null;
  department_id: string | null;
  company_id: string | null;
  /** ISO-8601 instant the rate must have been in force at. */
  at: string;
  /**
   * The currency the caller is already committed to, or null to accept
   * whatever the policy resolves to. A mismatch fails closed rather than
   * falling through - see the module header.
   */
  expected_currency: string | null;
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A syntactically complete ISO-8601 instant that also parses.
 *
 * Deliberately its own predicate rather than a re-export from `validate.ts`:
 * that module is the hot path for producer wire content and its rules exist to
 * keep untrusted strings out. A policy document is operator input on a
 * different trust footing, and coupling the two would mean a future tightening
 * of the wire grammar silently invalidated stored rate history.
 */
export function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * A canonical key for one *instant*, for duplicate detection.
 *
 * `ISO_INSTANT` admits several spellings of the same moment -
 * `2026-08-01T00:00:00Z`, `2026-08-01T00:00:00.000Z` and
 * `2026-08-01T09:00:00+09:00` are one instant written three ways. Keying a
 * duplicate check on the raw text would let two of them coexist for one scope,
 * and "the rate in force" would then be decided by array position rather than
 * refused. Every caller that asks "is this instant already taken?" must compare
 * on this value, never on the text.
 *
 * Resolution is the millisecond, which is what `Date.parse` yields and what the
 * resolvers compare. Two entries that differ only below a millisecond are
 * therefore the same key and are refused - fail-closed, and the ordering
 * between them would not have been observable anyway.
 *
 * The two prefixes keep the mapping injective: an unparseable string can only
 * arrive from a caller that skipped `isIsoInstant`, and it is then keyed by its
 * own text rather than collapsing onto one shared key.
 */
export function instantKey(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? `@${ms}` : `#${value}`;
}

/**
 * Half-up rounding for non-negative values.
 *
 * `Math.round` is already half-up for positives, but saying so here is the
 * point: rounding money is a decision, and every place that converts a
 * fractional amount into minor units goes through this one function so the
 * decision is made once and is visible.
 */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** Why a calculated rate could not be produced. Same posture as the ledger rules. */
export const RATE_CALCULATION_ERRORS = [
  'cost_not_finite',
  'cost_not_integer',
  'cost_out_of_range',
  'hours_not_finite',
  'hours_out_of_range',
  'rate_not_positive',
  'rate_out_of_range',
] as const;
export type RateCalculationError = (typeof RATE_CALCULATION_ERRORS)[number];

export type RateCalculationResult =
  | { ok: true; hourly_rate_minor: number }
  | { ok: false; error: RateCalculationError };

/**
 * `hourly_rate = monthly_employer_cost / monthly_working_hours`.
 *
 * The input is the cost the *employer* bears, which is what a customer can
 * state without disclosing anybody's payslip; statutory employer contributions
 * are included by whoever enters the number, not modelled here. Requiring a
 * salary would be a data-collection demand the product has no right to make
 * (Issue #41 §2), so this function never sees one.
 *
 * A result that rounds to 0 is refused rather than stored: a rate of zero would
 * turn every future `time_value_proxy` into a silent zero, which is exactly the
 * failure mode §5 of the issue forbids.
 */
export function hourlyRateFromMonthlyCost(
  monthlyEmployerCostMinor: number,
  monthlyWorkingHours: number,
): RateCalculationResult {
  if (typeof monthlyEmployerCostMinor !== 'number' || !Number.isFinite(monthlyEmployerCostMinor)) {
    return { ok: false, error: 'cost_not_finite' };
  }
  if (!Number.isInteger(monthlyEmployerCostMinor)) return { ok: false, error: 'cost_not_integer' };
  if (monthlyEmployerCostMinor <= 0 || monthlyEmployerCostMinor > MAX_MONTHLY_COST_MINOR) {
    return { ok: false, error: 'cost_out_of_range' };
  }
  if (typeof monthlyWorkingHours !== 'number' || !Number.isFinite(monthlyWorkingHours)) {
    return { ok: false, error: 'hours_not_finite' };
  }
  if (monthlyWorkingHours <= 0 || monthlyWorkingHours > MAX_MONTHLY_WORKING_HOURS) {
    return { ok: false, error: 'hours_out_of_range' };
  }

  const rate = roundHalfUp(monthlyEmployerCostMinor / monthlyWorkingHours);
  if (rate <= 0) return { ok: false, error: 'rate_not_positive' };
  if (rate > MAX_HOURLY_RATE_MINOR) return { ok: false, error: 'rate_out_of_range' };
  return { ok: true, hourly_rate_minor: rate };
}

/** The scope id a request offers for one scope, or null when it offers none. */
function requestedScopeId(request: RateRequest, scope: RateScope): string | null {
  if (scope === 'user') return request.user_id;
  if (scope === 'department') return request.department_id;
  return request.company_id;
}

type ScopeMatch = { entry: HourlyRateEntry; effective_to: string | null };

/**
 * The entry in force at `atMs` for one scope, plus the instant it stopped being
 * in force.
 *
 * Entries starting after `atMs` are not merely ignored: their earliest start is
 * the `effective_to` of the winner, which is what makes the evidence state a
 * *period* rather than an open-ended claim.
 */
function matchScope(
  entries: readonly HourlyRateEntry[],
  scope: RateScope,
  scopeId: string,
  atMs: number,
): ScopeMatch | null {
  let winner: HourlyRateEntry | null = null;
  let winnerMs = Number.NEGATIVE_INFINITY;
  let nextStart: string | null = null;
  let nextStartMs = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    if (entry.scope !== scope || entry.scope_id !== scopeId) continue;
    const startMs = Date.parse(entry.effective_from);
    if (!Number.isFinite(startMs)) continue;
    if (startMs <= atMs) {
      // Later start wins. Equal starts cannot occur: the ledger validator
      // refuses two entries whose scope, id and *parsed* `effective_from`
      // agree, so two spellings of one instant are rejected there rather than
      // tie-broken by position here (see `instantKey`).
      if (startMs > winnerMs) {
        winner = entry;
        winnerMs = startMs;
      }
    } else if (startMs < nextStartMs) {
      nextStartMs = startMs;
      nextStart = entry.effective_from;
    }
  }

  return winner === null ? null : { entry: winner, effective_to: nextStart };
}

function evidenceFromEntry(
  match: ScopeMatch,
  source: RateResolvedSource,
  policyVersion: string,
  at: string,
): RateEvidence {
  const entry = match.entry;
  return {
    resolved_source: source,
    entry_source: entry.source,
    scope: entry.scope,
    scope_id: entry.scope_id,
    hourly_rate_minor: entry.hourly_rate_minor,
    currency: entry.currency,
    basis: entry.basis,
    input_method: entry.input_method,
    effective_from: entry.effective_from,
    effective_to: match.effective_to,
    resolved_at: at,
    policy_version: policyVersion,
  };
}

/** The ARK fallback rendered as evidence, so the default is auditable like any other. */
export function arkDefaultEvidence(policyVersion: string, at: string): RateEvidence {
  return {
    resolved_source: 'ark_default',
    entry_source: null,
    scope: null,
    scope_id: null,
    hourly_rate_minor: ARK_DEFAULT_HOURLY_RATE_MINOR,
    currency: ARK_DEFAULT_CURRENCY,
    basis: 'fallback_proxy',
    input_method: 'ark_default',
    effective_from: null,
    effective_to: null,
    resolved_at: at,
    policy_version: policyVersion,
  };
}

/**
 * Resolves one hourly rate.
 *
 * Walks `user → department → company` and stops at the first scope that both
 * offers an id *and* has an entry in force at `request.at`. A scope with no id
 * is skipped (nothing was asked of it); a scope with an id but no entry in
 * force falls through, because "this user has no rate yet" is precisely the
 * case the fallback chain exists for.
 *
 * Everything else is a stop, not a fall-through:
 * - a resolved rate whose currency is not the expected one returns
 *   `currency_mismatch`, because quietly using the next scope's rate would
 *   substitute one person's money for another's;
 * - an unusable `at` returns `invalid_request` rather than being coerced to
 *   "now", which would make the answer depend on when it was asked.
 */
export function resolveHourlyRate(policy: HourlyRatePolicy, request: RateRequest): RateResolution {
  if (!isIsoInstant(request.at)) return { status: 'unavailable', reason: 'invalid_request' };
  if (request.expected_currency !== null && !isCurrencyCode(request.expected_currency)) {
    return { status: 'unavailable', reason: 'invalid_request' };
  }
  const atMs = Date.parse(request.at);

  for (const scope of RATE_RESOLUTION_ORDER) {
    const scopeId = requestedScopeId(request, scope);
    if (scopeId === null || scopeId === '') continue;
    const match = matchScope(policy.entries, scope, scopeId, atMs);
    if (match === null) continue;
    if (request.expected_currency !== null && match.entry.currency !== request.expected_currency) {
      return { status: 'unavailable', reason: 'currency_mismatch' };
    }
    return {
      status: 'resolved',
      evidence: evidenceFromEntry(match, scope, policy.policy_version, request.at),
    };
  }

  if (request.expected_currency !== null && request.expected_currency !== ARK_DEFAULT_CURRENCY) {
    // The fallback is denominated in JPY only. Converting it would need an FX
    // rate with a source and an effective time (§4.2); inventing one to keep a
    // number on the screen is exactly what "no silent zero" forbids.
    return { status: 'unavailable', reason: 'currency_mismatch' };
  }
  return { status: 'resolved', evidence: arkDefaultEvidence(policy.policy_version, request.at) };
}

/**
 * The value of `minutes` at `rate`, in minor units.
 *
 * Integer arithmetic all the way: the multiplication happens before the
 * division, and both operands are bounded so the product stays exact. Returns
 * null when the inputs are outside the bounds this module guarantees, which the
 * caller turns into `unavailable` rather than into a number.
 */
export function timeValueMinor(hourlyRateMinor: number, minutes: number): number | null {
  if (!Number.isInteger(hourlyRateMinor) || hourlyRateMinor <= 0) return null;
  if (hourlyRateMinor > MAX_HOURLY_RATE_MINOR) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_TIME_MINUTES) return null;
  return roundHalfUp((hourlyRateMinor * minutes) / 60);
}

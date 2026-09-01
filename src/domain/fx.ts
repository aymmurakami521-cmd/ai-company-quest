/**
 * FX policy and conversion - aggregation mode B of
 * `docs/cost-governance-roi-design.md` §7.3.1.
 *
 * Mode A (currency partition) remains the default and is untouched: subtotals
 * stay keyed by `(realization_status, unit)` and no conversion happens anywhere.
 * Mode B is *added* beside it, and it is only ever reached when an operator
 * writes `aggregation_mode: "reporting_currency_normalized"` into their own
 * ledger document.
 *
 * ## Where the rates come from
 *
 * From the operator's ledger document, and from nowhere else. This module
 * performs no I/O, opens no socket and knows no provider: a rate exists in this
 * process only because somebody wrote it into the file named by
 * `QUEST_VALUE_LEDGER_PATH`, on exactly the terms `company/org.snapshot.json`
 * and the hourly-rate policy already use (`docs/value-rate-design.md` §5).
 * There is deliberately no "fetch today's rate" path: a figure whose provenance
 * is a network call made at an unrecorded moment cannot satisfy §7.3.1's
 * requirement that every converted record carry its rate's source and effective
 * time, and adding one would make a read-only local screen depend on an
 * external service.
 *
 * ## How a rate is written
 *
 * As an exact rational between two *minor-unit* amounts:
 *
 * ```jsonc
 * { "from_currency": "USD", "to_currency": "JPY",
 *   "from_amount_minor": 10000, "to_amount_minor": 14825,   // $100.00 = ¥14,825
 *   "effective_from": "2026-01-01T00:00:00Z",
 *   "fx_source": "published_reference", "fx_rate_version": "2026-08" }
 * ```
 *
 * Two amounts rather than one decimal rate, for two reasons:
 *
 * - **No exponent table enters the arithmetic.** `MINOR_UNIT_EXPONENTS` in
 *   `rate.ts` is documented as a *display* table and falls back to 2 for a
 *   currency it does not list. A quoted rate like "148.25 JPY per USD" can only
 *   be applied to minor units by consulting that table for both currencies, and
 *   a wrong fallback there would silently scale an amount by 100. Stating both
 *   legs in minor units removes the guess entirely.
 * - **The rate is exact.** No decimal rate is parsed, so no rounding happens
 *   before the conversion; the single rounding step is the conversion itself.
 *
 * ## What is refused
 *
 * - **Inversion.** A `USD -> JPY` entry does not answer a `JPY -> USD` request.
 *   The reciprocal of a quoted rate is a different rate in the real world, and
 *   deriving one would be exactly the silent conversion §4.2 forbids.
 * - **Triangulation.** `USD -> JPY` and `JPY -> EUR` do not compose into
 *   `USD -> EUR`. The compounded rounding has no stated source and no stated
 *   effective time, so it could not be published as evidence.
 * - **A rate that is not in force yet.** Resolution happens at the instant the
 *   converted figure belongs to - a record's own `measurement_window.end` - so
 *   a rate added next quarter has an `effective_from` after that instant and
 *   cannot reach back into a figure somebody already read. This is the same
 *   two-part guarantee `rate.ts` gives for the hourly rate.
 *
 * A request with no answer returns `unavailable`. It never returns zero, and it
 * never falls back to "no conversion" - publishing an unconverted amount inside
 * a reporting-currency subtotal is the currency-mixing §7.3.1 exists to stop.
 *
 * Pure module: no I/O, no clock, no environment.
 */

import { DECIMAL_PLACES, formatFixed, divideHalfUp, scaledQuotient } from './decimal.ts';
import { isCurrencyCode, isIsoInstant } from './rate.ts';

/**
 * The two ways a money subtotal may be built (§7.3.1). `currency_partition` is
 * mode A and the default for every document that does not say otherwise.
 */
export const VALUE_AGGREGATION_MODES = ['currency_partition', 'reporting_currency_normalized'] as const;
export type ValueAggregationMode = (typeof VALUE_AGGREGATION_MODES)[number];

export const DEFAULT_VALUE_AGGREGATION_MODE: ValueAggregationMode = 'currency_partition';

/**
 * Where the operator got the rate. A closed vocabulary, never free text, and
 * deliberately none of these names a live service: every one of them describes
 * a human act of transcription into the ledger document.
 */
export const FX_SOURCES = ['operator_declared', 'contract_rate', 'published_reference'] as const;
export type FxSource = (typeof FX_SOURCES)[number];

/**
 * Ceiling on either leg of a rate.
 *
 * Both legs are bounded so the pair stays legible and so a mistyped rate cannot
 * turn a small amount into an astronomically large one before the result bound
 * catches it. The conversion arithmetic itself is `bigint` and does not depend
 * on this bound for exactness.
 */
export const MAX_FX_LEG_MINOR = 1_000_000_000_000;

/** One dated conversion rate for one ordered currency pair. */
export type FxRateEntry = {
  from_currency: string;
  to_currency: string;
  /** ISO-8601 instant. In force from here until the next entry for the pair. */
  effective_from: string;
  /** Integer minor units of `from_currency`, strictly positive. */
  from_amount_minor: number;
  /** Integer minor units of `to_currency`, strictly positive. */
  to_amount_minor: number;
  fx_source: FxSource;
  fx_rate_version: string;
};

/** An FX policy is just its entries; ordering is imposed at resolution time. */
export type FxPolicy = { entries: readonly FxRateEntry[] };

export const EMPTY_FX_POLICY: FxPolicy = { entries: [] };

/**
 * Exactly which rate was applied, frozen at the moment of use.
 *
 * This carries every item §7.3.1 makes mandatory for mode B: the source, the
 * rate and its version, the effective time, and the direction. The *original*
 * amount and currency are not here - they stay on the record the conversion was
 * applied to, and the read model publishes both sides (§4.2: the original is
 * never overwritten).
 */
export type FxEvidence = {
  from_currency: string;
  to_currency: string;
  /** The exact rational actually used. `to_amount_minor` per `from_amount_minor`. */
  from_amount_minor: number;
  to_amount_minor: number;
  /**
   * The same rate as a fixed-point decimal string, for reading: minor units of
   * `to_currency` per one minor unit of `from_currency`. It is a rendering of
   * the pair above, which stays the authoritative form.
   */
  fx_rate: string;
  fx_source: FxSource;
  fx_rate_version: string;
  /** The entry's own start. */
  fx_effective_from: string;
  /** The next entry's start for the same pair, or null while open-ended. */
  fx_effective_to: string | null;
  /** The instant the policy was evaluated *against* - not the wall clock. */
  fx_effective_at: string;
};

/** Why no rate could be produced. Closed vocabulary; never a free-text reason. */
export const FX_UNAVAILABLE_REASONS = ['no_applicable_rate', 'invalid_request'] as const;
export type FxUnavailableReason = (typeof FX_UNAVAILABLE_REASONS)[number];

export type FxResolution =
  | { status: 'resolved'; evidence: FxEvidence }
  | { status: 'unavailable'; reason: FxUnavailableReason };

export type FxRequest = {
  from_currency: string;
  to_currency: string;
  /** ISO-8601 instant the rate must have been in force at. */
  at: string;
};

/** The rate as a decimal string: minor units of `to` per one minor unit of `from`. */
export function fxRateDecimal(fromAmountMinor: number, toAmountMinor: number): string | null {
  if (!Number.isInteger(fromAmountMinor) || fromAmountMinor <= 0) return null;
  if (!Number.isInteger(toAmountMinor) || toAmountMinor <= 0) return null;
  const scaled = scaledQuotient(BigInt(toAmountMinor), BigInt(fromAmountMinor), DECIMAL_PLACES);
  return scaled === null ? null : formatFixed(scaled, DECIMAL_PLACES);
}

type FxMatch = { entry: FxRateEntry; effective_to: string | null };

/**
 * The entry in force at `atMs` for one ordered pair, plus the instant it stopped
 * being in force.
 *
 * Entries starting after `atMs` are not merely skipped: the earliest of them is
 * the winner's `effective_to`, so the evidence states a *period* rather than an
 * open-ended claim - the same shape `rate.ts` produces for an hourly rate.
 */
function matchPair(
  entries: readonly FxRateEntry[],
  from: string,
  to: string,
  atMs: number,
): FxMatch | null {
  let winner: FxRateEntry | null = null;
  let winnerMs = Number.NEGATIVE_INFINITY;
  let nextStart: string | null = null;
  let nextStartMs = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    // The pair is ordered. A `to -> from` entry is a different rate and is not
    // consulted here; see the module header on inversion.
    if (entry.from_currency !== from || entry.to_currency !== to) continue;
    const startMs = Date.parse(entry.effective_from);
    if (!Number.isFinite(startMs)) continue;
    if (startMs <= atMs) {
      // Later start wins. Equal starts cannot occur: the ledger validator
      // refuses two entries whose pair and *parsed* `effective_from` agree, so
      // two spellings of one instant are rejected there rather than tie-broken
      // by position here.
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

/**
 * Resolves one conversion rate.
 *
 * `from === to` is refused as `invalid_request` rather than answered with an
 * identity rate: an amount already in the reporting currency is not converted
 * at all, and manufacturing evidence saying it was would put a conversion in
 * the audit trail that never happened. Callers test for the identity case
 * before asking.
 */
export function resolveFxRate(policy: FxPolicy, request: FxRequest): FxResolution {
  if (!isCurrencyCode(request.from_currency) || !isCurrencyCode(request.to_currency)) {
    return { status: 'unavailable', reason: 'invalid_request' };
  }
  if (request.from_currency === request.to_currency) {
    return { status: 'unavailable', reason: 'invalid_request' };
  }
  if (!isIsoInstant(request.at)) return { status: 'unavailable', reason: 'invalid_request' };

  const match = matchPair(policy.entries, request.from_currency, request.to_currency, Date.parse(request.at));
  if (match === null) return { status: 'unavailable', reason: 'no_applicable_rate' };

  const rate = fxRateDecimal(match.entry.from_amount_minor, match.entry.to_amount_minor);
  if (rate === null) return { status: 'unavailable', reason: 'invalid_request' };

  return {
    status: 'resolved',
    evidence: {
      from_currency: match.entry.from_currency,
      to_currency: match.entry.to_currency,
      from_amount_minor: match.entry.from_amount_minor,
      to_amount_minor: match.entry.to_amount_minor,
      fx_rate: rate,
      fx_source: match.entry.fx_source,
      fx_rate_version: match.entry.fx_rate_version,
      fx_effective_from: match.entry.effective_from,
      fx_effective_to: match.effective_to,
      fx_effective_at: request.at,
    },
  };
}

/**
 * Applies a resolved rate to an amount in minor units.
 *
 * The multiplication happens in `bigint` before the division, so the result is
 * the exact rational rounded once, half away from zero. A double would lose the
 * low digits of a large ledger amount well before the bound below is reached.
 *
 * Returns null when the result would exceed `maxResultMinor`, which the caller
 * turns into an explicit "not converted" row. Clamping instead would publish a
 * number nobody computed.
 */
export function convertMinor(
  amountMinor: number,
  evidence: FxEvidence,
  maxResultMinor: number,
): number | null {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) return null;
  if (!Number.isInteger(evidence.from_amount_minor) || evidence.from_amount_minor <= 0) return null;
  if (!Number.isInteger(evidence.to_amount_minor) || evidence.to_amount_minor <= 0) return null;

  const converted = divideHalfUp(
    BigInt(amountMinor) * BigInt(evidence.to_amount_minor),
    BigInt(evidence.from_amount_minor),
  );
  if (converted === null) return null;
  if (converted > BigInt(maxResultMinor)) return null;
  return Number(converted);
}

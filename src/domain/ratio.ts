/**
 * The ratio layer - benefit-cost ratio and net ROI
 * (`docs/cost-governance-roi-design.md` §8).
 *
 * Absolute amounts alone answer "how much"; a ratio answers "was it worth it",
 * and that is the question §8 exists to keep honest. Two rules decide the whole
 * shape of this module, and both are refusals rather than features.
 *
 * ## 1. A ratio that cannot be computed is never a number
 *
 * Not 0, not `—`, not `∞`. §8.4 defines a closed `ratio_status` vocabulary of
 * *reasons*, and every row published here carries one. In particular
 * `undefined_zero_denominator` (the AI cost is known to be exactly 0) and
 * `blocked_unpriced_cost` (the cost has no amount yet) are different rows for
 * different facts: §3.6's separation of "zero" from "unknown" would collapse if
 * either rendered as the other, or as 0.
 *
 * Two members are added to §8.4's table here, additively - nothing in it is
 * removed or redefined:
 *
 * - `blocked_absent_value` - there is no monetary value subtotal for this
 *   realization status at all. §8.4's table assumes a numerator exists and only
 *   enumerates ways the *denominator* or the commensurability fails; without
 *   this member, "the ledger records no realized money" would have to be shown
 *   as a ratio of 0, which is the one thing §8.4 forbids.
 * - `blocked_absent_cost` - no `ai_cost` bucket was reported at all. Mapping
 *   this onto `blocked_unpriced_cost` would claim the operator declared a cost
 *   whose price is pending, which is a different statement (§3.6).
 *
 * ## 2. Estimated and realized never share a numerator
 *
 * One row per `realization_status`, and the numerator of each is the subtotal
 * for *that status only* (§8.3). `time_value_proxy` is `estimated` by contract
 * and `realized_cost_saving` is `realized` by contract, so there is no code path
 * in which the two can be added together and divided by a cost - the grouping
 * happens before any arithmetic, and no row anywhere sums across statuses. The
 * cost's own `estimated` / `finalized` distinction is carried on every row
 * beside the ratio, as §8.3 also requires.
 *
 * ## Scope and period
 *
 * §8.2 admits a ratio only when numerator and denominator share a currency, a
 * period, an attribution scope and a methodology.
 *
 * - *Scope* is uniform by construction: the ledger validator refuses any record
 *   whose `attribution_scope.company_id` differs from the ledger's, so every
 *   ratio here is a company-scope ratio. Per-department and per-user ratios
 *   would need a scoped cost, which the cost bucket does not carry.
 * - *Period* must be stated by the operator on the cost bucket. A record whose
 *   `measurement_window` lies inside that period is in the numerator; one that
 *   lies entirely outside it belongs to another period and is counted in
 *   `excluded_record_count`, visibly. A record that *straddles* the boundary is
 *   a genuine mismatch and blocks the row rather than being clipped.
 * - *Methodology*: every record in the numerator must share one
 *   `methodology_version`. `attribution_method` is deliberately not required to
 *   be identical: a derived `time_value_proxy` always carries
 *   `derived_from_time_saved` by construction, so requiring identity there
 *   would permanently block every estimated ratio without telling a reader
 *   anything true.
 *
 * Pure module: no I/O, no clock, no environment.
 */

import type { CostBucket, CostStatus } from './costBucket.ts';
import { DECIMAL_PLACES, decimalScale, formatFixed, scaledQuotient } from './decimal.ts';
import type { ValueAggregationMode } from './fx.ts';
import {
  REALIZATION_STATUSES,
  type AggregatedRecord,
  type MeasurementWindow,
  type RealizationStatus,
} from './value.ts';

/**
 * §8.4's vocabulary, plus the two absence members documented in the module
 * header. Closed: a reason outside this list is never published.
 */
export const RATIO_STATUSES = [
  'computed',
  'undefined_zero_denominator',
  'blocked_unpriced_cost',
  /**
   * Reserved by §8.4 for consumption whose `provider` / `model` could not be
   * resolved (§3.5). This build has no provider usage telemetry at all - AI
   * cost is a figure the operator states - so nothing can currently produce it.
   * It is kept in the vocabulary so the telemetry work does not have to widen a
   * published enum later.
   */
  'blocked_unresolved_cost',
  'blocked_non_monetary_operand',
  'blocked_currency_mismatch',
  'blocked_scope_mismatch',
  'blocked_methodology_mismatch',
  'blocked_absent_value',
  'blocked_absent_cost',
] as const;
export type RatioStatus = (typeof RATIO_STATUSES)[number];

/**
 * One ratio row: one `realization_status`, one currency.
 *
 * `benefit_cost_ratio` and `net_roi` are fixed-point decimal *strings*
 * (`decimal.ts` explains why) and are present only on a `computed` row that the
 * viewer is allowed to see. `value_minor` and `cost_minor` are the exact
 * operands, so a reader can recompute the ratio rather than trust it.
 */
export type RatioRow = {
  realization_status: RealizationStatus;
  /** The currency both operands are in, or the reporting currency when blocked. */
  currency: string;
  ratio_status: RatioStatus;
  /** The denominator's own `estimated` / `finalized` / `unpriced` (§8.3). */
  cost_status: CostStatus | null;
  /** The cost period the ratio is bounded to, when one was stated. */
  period: MeasurementWindow | null;
  /** Records inside the period that form the numerator. */
  included_record_count: number;
  /** Records of this status and currency that belong to another period. */
  excluded_record_count: number;
  /** The single methodology version behind the numerator, when there is one. */
  methodology_version: string | null;
  benefit_cost_ratio?: string;
  net_roi?: string;
  value_minor?: number;
  cost_minor?: number;
  amount_withheld?: true;
};

export type RatioInput = {
  /**
   * Every value record, already normalised for the aggregation mode: in mode B
   * the monetary ones are in the reporting currency, and any that could not be
   * converted have been removed by the caller and reported separately. This
   * module never converts anything.
   */
  records: readonly AggregatedRecord[];
  ai_cost: CostBucket | null;
  reporting_currency: string;
  mode: ValueAggregationMode;
  /**
   * Mode B only: the cost bucket exists but could not be brought into the
   * reporting currency. Its own currency is then not commensurate with a
   * normalised numerator, so every row is `blocked_currency_mismatch`.
   */
  cost_conversion_failed?: boolean;
  /**
   * Mode B only: realization statuses that hold money with no conversion into
   * the reporting currency. Their numerator subtotal is not published at all
   * (§7.3.1), so a ratio built on it would rest on a total nobody computed -
   * and one that is quietly smaller than the truth. Blocked, not approximated.
   */
  blocked_statuses?: readonly RealizationStatus[];
  /** True under `restricted`: statuses stay, every figure is withheld. */
  withhold_amounts: boolean;
};

type Window = { start: number; end: number };

function parseWindow(window: MeasurementWindow): Window | null {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/** Wholly inside the period. Equal boundaries count as inside. */
function contains(period: Window, record: Window): boolean {
  return record.start >= period.start && record.end <= period.end;
}

/** Shares any instant with the period. */
function overlaps(period: Window, record: Window): boolean {
  return record.start <= period.end && record.end >= period.start;
}

type Group = {
  currency: string;
  candidates: AggregatedRecord[];
};

/**
 * Groups this status's monetary records by the currency they are stated in.
 *
 * Mode B has already normalised every survivor to the reporting currency, so
 * there is at most one group; mode A keeps one group per currency, which is
 * what makes a JPY numerator against a USD cost report a currency mismatch
 * instead of quietly comparing them.
 */
function groupsFor(records: readonly AggregatedRecord[], status: RealizationStatus): Group[] {
  const byCurrency = new Map<string, AggregatedRecord[]>();
  for (const record of records) {
    if (record.value_kind !== 'monetary') continue;
    if (record.realization_status !== status) continue;
    const existing = byCurrency.get(record.unit);
    if (existing === undefined) byCurrency.set(record.unit, [record]);
    else existing.push(record);
  }
  return [...byCurrency.keys()].sort().map((currency) => ({
    currency,
    candidates: byCurrency.get(currency) as AggregatedRecord[],
  }));
}

function hasNonMonetary(records: readonly AggregatedRecord[], status: RealizationStatus): boolean {
  for (const record of records) {
    if (record.value_kind === 'non_monetary' && record.realization_status === status) return true;
  }
  return false;
}

type Resolved = {
  status: RatioStatus;
  included: AggregatedRecord[];
  excluded: number;
  methodology: string | null;
};

/**
 * Decides one row's `ratio_status`, in a fixed order.
 *
 * The order is the order in which a reader needs the answer: whether a
 * denominator exists at all, then whether a numerator exists at all, then
 * whether the two are commensurate (§8.2), then whether the division is
 * defined. Reporting the first failure rather than a list keeps the closed
 * vocabulary single-valued, and the earlier checks are the ones that make the
 * later ones meaningless.
 */
function resolveRow(input: RatioInput, group: Group | null, status: RealizationStatus): Resolved {
  const cost = input.ai_cost;
  const empty: Resolved = { status: 'computed', included: [], excluded: 0, methodology: null };

  if (cost === null) return { ...empty, status: 'blocked_absent_cost' };
  if (cost.cost_status === 'unpriced') return { ...empty, status: 'blocked_unpriced_cost' };

  // Before the absence checks: a status whose money could not be converted has
  // a numerator that exists but cannot be totalled, which is a different fact
  // from having no numerator at all. Reporting it as absent would read as "this
  // company created no realized value".
  if (input.blocked_statuses?.includes(status) === true) {
    return { ...empty, status: 'blocked_currency_mismatch' };
  }

  if (group === null) {
    return {
      ...empty,
      status: hasNonMonetary(input.records, status) ? 'blocked_non_monetary_operand' : 'blocked_absent_value',
    };
  }

  if (cost.period === null) return { ...empty, status: 'blocked_scope_mismatch' };
  const period = parseWindow(cost.period);
  if (period === null) return { ...empty, status: 'blocked_scope_mismatch' };

  if (input.cost_conversion_failed === true) return { ...empty, status: 'blocked_currency_mismatch' };
  if (cost.currency !== group.currency) return { ...empty, status: 'blocked_currency_mismatch' };

  const included: AggregatedRecord[] = [];
  let excluded = 0;
  for (const record of group.candidates) {
    const window = parseWindow(record.measurement_window);
    // A window the validator already accepted always parses; treating an
    // unparseable one as a mismatch keeps the fallback fail-closed anyway.
    if (window === null) return { ...empty, status: 'blocked_scope_mismatch' };
    if (contains(period, window)) {
      included.push(record);
      continue;
    }
    // Straddling the boundary is not "another period" - it is a period that
    // does not line up, and clipping it would invent a figure (§8.2).
    if (overlaps(period, window)) return { ...empty, status: 'blocked_scope_mismatch' };
    excluded += 1;
  }

  if (included.length === 0) {
    return { ...empty, status: 'blocked_absent_value', excluded };
  }

  const methodologies = new Set(included.map((record) => record.methodology_version));
  if (methodologies.size > 1) {
    return { status: 'blocked_methodology_mismatch', included, excluded, methodology: null };
  }
  const methodology = included[0]?.methodology_version ?? null;

  if (cost.amount_minor === null) {
    // A priced bucket always has an amount (§3.6). Reaching here would mean the
    // cross-field contract was bypassed, so the row refuses rather than guesses.
    return { status: 'blocked_unpriced_cost', included, excluded, methodology };
  }
  if (cost.amount_minor === 0) {
    return { status: 'undefined_zero_denominator', included, excluded, methodology };
  }

  return { status: 'computed', included, excluded, methodology };
}

/**
 * Builds every ratio row for a ledger.
 *
 * Exactly one row per `(realization_status, currency)` that has monetary
 * records, plus one row for a status that has none: a status that is silently
 * absent from the output reads as a status the product does not have.
 *
 * Deterministic order: realized before estimated, then currency ascending.
 */
export function buildRatioRows(input: RatioInput): RatioRow[] {
  const rows: RatioRow[] = [];
  const scale = decimalScale(DECIMAL_PLACES);

  for (const status of REALIZATION_STATUSES) {
    const groups = groupsFor(input.records, status);
    const forStatus: (Group | null)[] = groups.length === 0 ? [null] : groups;

    for (const group of forStatus) {
      const resolved = resolveRow(input, group, status);
      const cost = input.ai_cost;
      const row: RatioRow = {
        realization_status: status,
        currency: group === null ? input.reporting_currency : group.currency,
        ratio_status: resolved.status,
        cost_status: cost === null ? null : cost.cost_status,
        period: cost === null || cost.period === null ? null : { ...cost.period },
        included_record_count: resolved.included.length,
        excluded_record_count: resolved.excluded,
        methodology_version: resolved.methodology,
      };

      if (resolved.status !== 'computed') {
        rows.push(row);
        continue;
      }

      // Reachable only on a `computed` row: `resolveRow` has already refused a
      // null or zero denominator, so both operands are known and positive.
      const costMinor = cost?.amount_minor ?? 0;
      let valueMinor = 0;
      for (const record of resolved.included) valueMinor += record.quantity;

      const ratioScaled = scaledQuotient(BigInt(valueMinor), BigInt(costMinor), DECIMAL_PLACES);
      if (ratioScaled === null) {
        row.ratio_status = 'undefined_zero_denominator';
        rows.push(row);
        continue;
      }

      if (input.withhold_amounts) {
        // A ratio is dimensionless and discloses neither operand on its own,
        // but it is still a figure derived from money, and `restricted` is the
        // default for every such figure in this read model. Showing ratios to a
        // viewer who may not see amounts is a role-based decision, and roles
        // need an identity this process does not have
        // (`docs/value-rate-design.md` §6).
        row.amount_withheld = true;
      } else {
        row.benefit_cost_ratio = formatFixed(ratioScaled, DECIMAL_PLACES);
        // net ROI is `benefit-cost ratio - 1` exactly. Deriving it from the
        // already-rounded ratio rather than rounding a second quotient keeps
        // the two published figures consistent with each other (§8.1).
        row.net_roi = formatFixed(ratioScaled - scale, DECIMAL_PLACES);
        row.value_minor = valueMinor;
        row.cost_minor = costMinor;
      }
      rows.push(row);
    }
  }

  return rows;
}

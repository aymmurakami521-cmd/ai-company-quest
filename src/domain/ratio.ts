/**
 * The ratio layer - benefit-cost ratio and net ROI
 * (`docs/cost-governance-roi-design.md` §8).
 *
 * Absolute amounts alone answer "how much"; a ratio answers "was it worth it",
 * and that is the question §8 exists to keep honest. Three rules decide the
 * whole shape of this module, and all three are refusals rather than features.
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
 * Three members are added to §8.4's table here, additively - nothing in it is
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
 * - `withheld_by_disclosure` - rule 3 below.
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
 * ## 3. A restricted reader learns the restriction, never the figure
 *
 * Exactly two of this module's outcomes are decided by the *value* of the
 * denominator: `computed` (the AI cost is some non-zero amount) and
 * `undefined_zero_denominator` (it is exactly 0). Publishing either of them to a
 * reader who may not see amounts discloses the amount by elimination - and the
 * one it discloses most sharply is the exact figure 0, which §3.3 treats as a
 * claim in its own right ("this company spent nothing on AI"), not as an
 * absence.
 *
 * So under `withhold_amounts` the two collapse into a single
 * `withheld_by_disclosure`, decided *before* `amount_minor` is compared to
 * anything. The restriction is stated - `withheld_by_disclosure` is a reason,
 * and the read model renders it as 権限により非表示 - while the figure behind it
 * is not, in either direction. Suppressing only the zero case would leave the
 * zero readable by elimination, which is the same disclosure with more steps.
 *
 * The purely structural reasons are *not* collapsed: a missing period, a
 * currency mismatch or an absent cost bucket is not derived from an amount, is
 * already legible from the row's own `cost_status` / `period` fields, and is
 * what tells the operator their ledger needs a fix. Withholding those would
 * withhold the reason without protecting anything.
 *
 * No amount key is ever written on a withheld row, so `0` is never published as
 * the value of one: `restricted` is absence-of-key plus a stated reason, never a
 * zero (`docs/value-rate-design.md` §11.5).
 *
 * ## The denominator has a name, and the name is part of the contract
 *
 * §8.1 defines `benefit-cost ratio = business_value / ai_cost`. That definition
 * is fixed: the ARK platform fee is **not** in the denominator, and this module
 * has no way to put it there. What it does have is a registry
 * (`RATIO_TERM_SETS`) that binds a denominator to the *names* its figures are
 * published under, so a later All-in / TCO ratio is added as a **new term set
 * with new names** rather than by re-pointing `benefit_cost_ratio` at a
 * different denominator. `ratioTermConflicts` refuses a registry in which two
 * term sets share a name or a denominator, which is what makes "a second
 * indicator cannot silently redefine the first" a property of the code rather
 * than of somebody's care. See `docs/value-rate-design.md` §11.6.
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
 * §8.4's vocabulary, plus the three members documented in the module header.
 * Closed: a reason outside this list is never published.
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
  /**
   * The reader may not see amounts, and telling them which of the two
   * amount-derived outcomes applies would be showing them one (rule 3).
   *
   * This is a *restriction*, not a failure of the data: the same ledger read at
   * `full` produces `computed` or `undefined_zero_denominator`. Reusing one of
   * the `blocked_*` members would say the ledger is short of something, which
   * would send an operator looking for a problem that is not there.
   */
  'withheld_by_disclosure',
] as const;
export type RatioStatus = (typeof RATIO_STATUSES)[number];

/**
 * The statuses whose presence on a row is decided by the *value* of the
 * denominator rather than by its structure.
 *
 * Named so the disclosure rule can be stated as a property - none of these may
 * appear on a restricted payload - instead of being re-derived from the branch
 * order in `resolveRow` by every reader and every test. `buildRatioRows` reads
 * it as a last line of defence, so adding a member here is enough to make a new
 * amount-derived status withheld even if `resolveRow` forgets - though that
 * clause guards a path `resolveRow` cannot currently take, so it is unreachable
 * today and no test covers it.
 */
export const AMOUNT_DERIVED_RATIO_STATUSES = ['computed', 'undefined_zero_denominator'] as const;

/**
 * Which cost a ratio's denominator is.
 *
 * One member today, by §8.1. An All-in / TCO indicator that folded the ARK
 * platform fee in would be a **new member here plus a new term set below** - a
 * different ratio, published beside this one under its own name. It is
 * deliberately not a knob: nothing reads this to *choose* a denominator, so
 * there is no configuration that can turn `benefit_cost_ratio` into a figure
 * over a different cost.
 */
export const RATIO_COST_BASES = ['ai_cost'] as const;
export type RatioCostBasis = (typeof RATIO_COST_BASES)[number];

/**
 * The names one denominator's figures are published under.
 *
 * The point of stating them as data is that a second indicator has to declare
 * its names too, and `ratioTermConflicts` then refuses the pair if it reuses
 * any of these. "Add an All-in ROI" therefore cannot be done by quietly
 * widening what `benefit_cost_ratio` means; it has to be done by naming
 * something new.
 */
export type RatioTermSet = {
  /** The denominator these names belong to. Unique across the registry. */
  cost_basis: RatioCostBasis;
  /** The definition, in the words §8.1 states it in. */
  definition: string;
  /** Payload key of the ratio itself. Unique across the registry. */
  ratio_key: string;
  /** Payload key of the net ROI derived from it. Unique across the registry. */
  net_roi_key: string;
  /** Payload key of the denominator operand. Unique across the registry. */
  cost_key: string;
  /** What the ratio is called. Unique across the registry, in both languages. */
  term_en: string;
  label_ja: string;
  /**
   * What the net ROI derived from it is called. Under the same uniqueness rule:
   * a derived figure is still something a person reads off the screen, and a
   * second indicator calling its own derivation 純ROI would rename this one.
   */
  net_term_en: string;
  net_label_ja: string;
};

/**
 * §8.1's ratio: the only one this build publishes.
 *
 * Frozen, because the load-time check below is what makes the registry a rule
 * rather than a suggestion, and a rule that anything holding the module can
 * edit afterwards is neither.
 */
export const AI_COST_TERMS: RatioTermSet = Object.freeze({
  cost_basis: 'ai_cost',
  definition: 'business_value / ai_cost',
  ratio_key: 'benefit_cost_ratio',
  net_roi_key: 'net_roi',
  cost_key: 'cost_minor',
  term_en: 'benefit-cost ratio',
  label_ja: '費用対効果比',
  net_term_en: 'net ROI',
  net_label_ja: '純ROI',
});

/**
 * Every ratio this build publishes. Exactly one entry, on purpose: the All-in /
 * TCO indicator is *not* implemented here, only made addable.
 */
export const RATIO_TERM_SETS: readonly RatioTermSet[] = Object.freeze([AI_COST_TERMS]);

/**
 * The part of a term set the conflict rules read.
 *
 * Deliberately looser than `RatioTermSet`: a *proposed* indicator - the one
 * somebody is about to add - names a denominator that is not in
 * `RATIO_COST_BASES` yet, and the rules have to be able to judge it before it
 * is admitted rather than only after.
 */
export type RatioTermNames = {
  cost_basis: string;
  ratio_key: string;
  net_roi_key: string;
  cost_key: string;
  term_en: string;
  label_ja: string;
  net_term_en: string;
  net_label_ja: string;
};

/** The payload keys a term set claims. */
export function ratioTermKeys(set: RatioTermNames): readonly string[] {
  return [set.ratio_key, set.net_roi_key, set.cost_key];
}

/**
 * The names a term set claims *to a person*.
 *
 * Checked for collisions alongside the payload keys, because "add it under a
 * separate term name" is a statement about what a reader sees, not only about
 * what a parser sees. A second indicator that published `all_in_ratio` while
 * calling itself 費用対効果比 on screen would rename the existing ratio for
 * every human looking at it.
 */
export function ratioTermLabels(set: RatioTermNames): readonly string[] {
  return [set.term_en, set.label_ja, set.net_term_en, set.net_label_ja];
}

/**
 * Everything wrong with a registry, as stable strings; empty for a good one.
 *
 * Two rules, and each of them is one of the constraints this structure exists
 * to hold:
 *
 * - **no shared payload key.** A second term set may not publish under a key the
 *   first already uses. That is what "the existing ratio keeps its meaning"
 *   reduces to once a second indicator exists: a reader who finds
 *   `benefit_cost_ratio` in the payload knows which denominator produced it,
 *   because only one term set is ever allowed to write it.
 * - **no shared display name.** The same rule for the four display names, the
 *   derived net-ROI pair included. A payload key nobody reads is not the name
 *   the owner meant; 費用対効果比 and 純ROI on the screen are.
 * - **no shared denominator.** Two names for the same division are two ROI
 *   models of the same thing, which is the duplication #41 refuses. An All-in
 *   indicator is a different denominator; a synonym is not.
 *
 * Reported rather than thrown so the rule can be tested against a hypothetical
 * registry without the test having to catch anything.
 */
export function ratioTermConflicts(sets: readonly RatioTermNames[]): string[] {
  const conflicts: string[] = [];
  const seenBasis = new Set<string>();
  const seenKey = new Map<string, string>();
  const seenName = new Map<string, string>();
  for (const set of sets) {
    if (seenBasis.has(set.cost_basis)) {
      conflicts.push(`duplicate cost_basis: ${set.cost_basis}`);
    }
    seenBasis.add(set.cost_basis);
    for (const key of ratioTermKeys(set)) {
      const owner = seenKey.get(key);
      if (owner !== undefined) {
        conflicts.push(`duplicate key: ${key} (${owner}, ${set.cost_basis})`);
        continue;
      }
      seenKey.set(key, set.cost_basis);
    }
    for (const name of ratioTermLabels(set)) {
      const owner = seenName.get(name);
      if (owner !== undefined) {
        conflicts.push(`duplicate name: ${name} (${owner}, ${set.cost_basis})`);
        continue;
      }
      seenName.set(name, set.cost_basis);
    }
  }
  return conflicts.sort();
}

// A registry that breaks its own rules would publish two different numbers
// under one name, so the module refuses to load rather than let a build ship
// with it. Deterministic and dependency-free: it reads a frozen literal.
const REGISTRY_CONFLICTS = ratioTermConflicts(RATIO_TERM_SETS);
if (REGISTRY_CONFLICTS.length > 0) {
  throw new Error(`RATIO_TERM_SETS is not well formed: ${REGISTRY_CONFLICTS.join('; ')}`);
}

/** The term set for a denominator. Total over `RatioCostBasis` by construction. */
export function ratioTermsFor(basis: RatioCostBasis): RatioTermSet {
  const found = RATIO_TERM_SETS.find((set) => set.cost_basis === basis);
  if (found === undefined) throw new Error(`no ratio term set for ${basis}`);
  return found;
}

/**
 * One ratio row: one `realization_status`, one currency, one denominator.
 *
 * `benefit_cost_ratio` and `net_roi` are fixed-point decimal *strings*
 * (`decimal.ts` explains why) and are present only on a `computed` row that the
 * viewer is allowed to see. `value_minor` and `cost_minor` are the exact
 * operands, so a reader can recompute the ratio rather than trust it.
 *
 * The three optional amount keys are the ones `RATIO_TERM_SETS` names for
 * `ai_cost`; `test/value-ratio.test.ts` holds the two in step, so a rename on
 * one side cannot drift from the other.
 */
export type RatioRow = {
  realization_status: RealizationStatus;
  /**
   * Which cost was divided by. Stated on every row, including blocked ones, so
   * that a row is self-describing the day a second indicator exists - a reader
   * never has to infer the denominator from the key that happens to be present.
   */
  cost_basis: RatioCostBasis;
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
  /**
   * Deliberately no `amount_withheld` here, unlike every other section of the
   * read model. There it means "a figure exists and you may not see it"; on a
   * withheld ratio row that claim would be a disclosure in itself, because
   * whether a ratio exists is exactly what a zero denominator decides.
   * `ratio_status: 'withheld_by_disclosure'` is the whole statement.
   */
};

export type RatioInput = {
  /**
   * Every value record, already normalised for the aggregation mode: in mode B
   * the monetary ones are in the reporting currency, and any that could not be
   * converted have been removed by the caller and reported separately. This
   * module never converts anything.
   */
  records: readonly AggregatedRecord[];
  /**
   * §8.1's denominator, and the only one. There is deliberately no second cost
   * field here: the ARK fee is a different indicator (see the module header),
   * not a variant of this one, so it is not something a caller can pass in.
   */
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
  /** True under `restricted`: see rule 3 in the module header. */
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
 *
 * Every check before the last two reads structure - a currency, a period, a
 * `cost_status`, a record count - rather than the denominator's value, which is
 * why only the last two are withheld under restriction. One caller-supplied
 * input is an exception worth naming: `cost_conversion_failed` is set by
 * `convertCostBucket` when a mode-B conversion overflows `MAX_COST_AMOUNT_MINOR`,
 * so `blocked_currency_mismatch` can, at ~10^12 minor units, imply a lower
 * bound on the cost. It never implies 0, and it pre-dates this layer's
 * disclosure rule (`docs/value-rate-design.md` §11.5).
 */
function resolveRow(input: RatioInput, group: Group | null, status: RealizationStatus): Resolved {
  const cost = input.ai_cost;
  // Seeded with a status that publishes nothing. Every `return { ...empty, … }`
  // below overrides it, but a future one that forgets must fail closed rather
  // than fall through to `computed` and hand a restricted reader real money.
  const empty: Resolved = { status: 'blocked_absent_value', included: [], excluded: 0, methodology: null };

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

  // Rule 3. Returned *above* every comparison against `amount_minor`, so the
  // withheld outcome is not one branch of a decision about the figure - it is
  // the decision not to make that one. A reader who sees this status learns
  // that a denominator exists and is priced, which they can already read off
  // `cost_status`, and nothing about what it is.
  if (input.withhold_amounts) {
    return { status: 'withheld_by_disclosure', included, excluded, methodology };
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
 * Every row is against §8.1's `ai_cost` denominator and says so. A second
 * indicator would add its own rows, carrying its own `cost_basis` and its own
 * term set's keys, beside these - it would not change one figure here.
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
        cost_basis: AI_COST_TERMS.cost_basis,
        currency: group === null ? input.reporting_currency : group.currency,
        ratio_status: resolved.status,
        cost_status: cost === null ? null : cost.cost_status,
        period: cost === null || cost.period === null ? null : { ...cost.period },
        included_record_count: resolved.included.length,
        excluded_record_count: resolved.excluded,
        methodology_version: resolved.methodology,
      };

      // The one row that "there is a ratio" and "the cost is exactly zero" both
      // produce, and it carries no amount key at all - not a 0, not a null
      // standing in for one.
      //
      // The second clause is defence in depth and is **unreachable today**:
      // `resolveRow` cannot return an amount-derived status while amounts are
      // withheld, so no test exercises it. It is here so that if a later edit
      // ever lets one through, the money still does not get published - and it
      // sits above the `computed` branch so it also covers the
      // `undefined_zero_denominator` assignment made further down.
      const amountDerived = (AMOUNT_DERIVED_RATIO_STATUSES as readonly string[]).includes(resolved.status);
      if (resolved.status === 'withheld_by_disclosure' || (input.withhold_amounts && amountDerived)) {
        row.ratio_status = 'withheld_by_disclosure';
        rows.push(row);
        continue;
      }

      if (resolved.status !== 'computed') {
        rows.push(row);
        continue;
      }

      // Reachable only on a `computed` row, which `resolveRow` returns only when
      // amounts are disclosed: a null, zero or withheld denominator has already
      // been refused, so both operands are known, positive and publishable.
      const costMinor = cost?.amount_minor ?? 0;
      let valueMinor = 0;
      for (const record of resolved.included) valueMinor += record.quantity;

      const ratioScaled = scaledQuotient(BigInt(valueMinor), BigInt(costMinor), DECIMAL_PLACES);
      if (ratioScaled === null) {
        row.ratio_status = 'undefined_zero_denominator';
        rows.push(row);
        continue;
      }

      row.benefit_cost_ratio = formatFixed(ratioScaled, DECIMAL_PLACES);
      // net ROI is `benefit-cost ratio - 1` exactly. Deriving it from the
      // already-rounded ratio rather than rounding a second quotient keeps
      // the two published figures consistent with each other (§8.1).
      row.net_roi = formatFixed(ratioScaled - scale, DECIMAL_PLACES);
      row.value_minor = valueMinor;
      row.cost_minor = costMinor;
      rows.push(row);
    }
  }

  return rows;
}

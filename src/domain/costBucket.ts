/**
 * The two cost figures the ROI screen has to show beside business value:
 * AI-related cost, and the ARK fee.
 *
 * This is deliberately *not* a usage/cost telemetry model. Normalising provider
 * usage into cost is a separate, later piece of work
 * (`docs/cost-governance-roi-design.md` §9.3), and rebuilding it is explicitly
 * out of scope for Issue #41. What is needed here is narrower: a reported
 * period total that the dashboard can display *without* letting it be confused
 * with business value, and without letting "not priced yet" render as ¥0.
 *
 * The one rule carried over verbatim is §3.6's cross-field invariant, because
 * it is the rule that keeps 0 and unknown apart:
 *
 * | `cost_status` | `amount_minor` | `currency`  | `pricing_source` |
 * |---------------|----------------|-------------|------------------|
 * | `estimated`   | required (0 ok)| required    | required         |
 * | `finalized`   | required (0 ok)| required    | required         |
 * | `unpriced`    | must be null   | must be null| may be null      |
 *
 * `unpriced` does not mean zero. A confirmed 0 is `finalized` with an amount of
 * 0 - a free tier really can cost nothing - and the two must never collapse
 * into one another.
 */

import { isCurrencyCode } from './rate.ts';
import type { MeasurementWindow } from './value.ts';

export const COST_STATUSES = ['estimated', 'finalized', 'unpriced'] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

/** Where the price came from. Closed vocabulary; a version string, never a price table. */
export const PRICING_SOURCES = ['provider_invoice', 'price_list', 'contract_rate'] as const;
export type PricingSource = (typeof PRICING_SOURCES)[number];

/** Same bound as a monetary value quantity, so a mixed total cannot overflow. */
export const MAX_COST_AMOUNT_MINOR = 1_000_000_000_000;

export type CostBucket = {
  cost_status: CostStatus;
  /** Integer minor units, or null when `unpriced`. 0 is a value, not an absence. */
  amount_minor: number | null;
  /** ISO 4217, or null when `unpriced`. */
  currency: string | null;
  pricing_source: PricingSource | null;
  /** The version of the price list or contract the amount came from. */
  pricing_version: string | null;
  /**
   * The period the amount covers, when the operator stated one.
   *
   * Optional in the document and null when absent, because an ROI screen that
   * only *displays* a cost total does not need it - and every ledger written
   * before this field existed must keep validating.
   *
   * It is required for a *ratio*, though. `docs/cost-governance-roi-design.md`
   * §8.2 admits a benefit-cost ratio only when the value's `measurement_window`
   * and the cost's period are the same, and a bucket with no period offers no
   * way to establish that. Rather than assume the bucket covers whatever window
   * the value records happen to span - a silent assumption of exactly the kind
   * §4.2 and §7.3.1 forbid about conversion - the ratio layer reports
   * `blocked_scope_mismatch` and says so.
   */
  period: MeasurementWindow | null;
};

export const COST_RULE_VIOLATIONS = [
  'unknown_cost_status',
  'amount_required',
  'amount_not_integer',
  'amount_negative',
  'amount_out_of_range',
  'amount_not_allowed',
  'currency_required',
  'currency_invalid',
  'currency_not_allowed',
  'pricing_source_required',
  'period_invalid',
] as const;
export type CostRuleViolation = (typeof COST_RULE_VIOLATIONS)[number];

/** Checks one bucket against §3.6. Returns every violated rule, not just the first. */
export function checkCostBucket(bucket: CostBucket): CostRuleViolation[] {
  if (!(COST_STATUSES as readonly string[]).includes(bucket.cost_status)) {
    return ['unknown_cost_status'];
  }
  const violations: CostRuleViolation[] = [];

  // The period is orthogonal to the amount: an `unpriced` bucket may still know
  // which period it will eventually price, so this is checked on every branch.
  if (bucket.period !== null) {
    const startMs = Date.parse(bucket.period.start);
    const endMs = Date.parse(bucket.period.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      violations.push('period_invalid');
    }
  }

  if (bucket.cost_status === 'unpriced') {
    if (bucket.amount_minor !== null) violations.push('amount_not_allowed');
    if (bucket.currency !== null) violations.push('currency_not_allowed');
    return violations;
  }

  if (bucket.amount_minor === null) violations.push('amount_required');
  else if (!Number.isInteger(bucket.amount_minor)) violations.push('amount_not_integer');
  else if (bucket.amount_minor < 0) violations.push('amount_negative');
  else if (bucket.amount_minor > MAX_COST_AMOUNT_MINOR) violations.push('amount_out_of_range');

  if (bucket.currency === null) violations.push('currency_required');
  else if (!isCurrencyCode(bucket.currency)) violations.push('currency_invalid');

  if (bucket.pricing_source === null) violations.push('pricing_source_required');

  return violations;
}

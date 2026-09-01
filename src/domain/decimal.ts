/**
 * Exact decimal arithmetic for figures that are not whole minor units.
 *
 * Everything else in the value path is an integer count of minor units, and
 * `rate.ts` explains why: money in a float makes the last digit a property of
 * the environment rather than of the ledger. Two figures in this build are not
 * integers by nature - an FX rate and a ratio - so they are computed here as
 * exact rationals over `bigint` and published as *decimal strings*.
 *
 * A string rather than a number, deliberately:
 *
 * - a ratio can legitimately be far outside the range a double represents
 *   exactly (a full ledger's subtotal over a one-minor-unit cost is ~4e15, and
 *   scaling that to six decimal places puts it past `Number.MAX_SAFE_INTEGER`),
 *   so publishing a JSON number would round the answer silently;
 * - the same payload has to render identically in the browser and in the test
 *   process, and a string has no parsing step in between to disagree about.
 *
 * Pure module: no I/O, no clock, no environment, and nothing here throws - an
 * unusable input returns null, which the caller turns into an explicit status
 * rather than into a number.
 */

/** Decimal places every published rate and ratio carries. Fixed, not a setting. */
export const DECIMAL_PLACES = 6;

const TEN = 10n;

/** `10n ** BigInt(places)`, for the small non-negative `places` used here. */
export function decimalScale(places: number = DECIMAL_PLACES): bigint {
  if (!Number.isInteger(places) || places < 0 || places > 18) return 1n;
  return TEN ** BigInt(places);
}

/**
 * `numerator / denominator`, rounded half away from zero.
 *
 * Half *away from zero* rather than half up towards positive infinity, so the
 * rounding of a negative net ROI mirrors the rounding of a positive one; a rule
 * that treats -0.5 and 0.5 differently would make the sign of a figure change
 * how precise it is.
 *
 * Returns null for a non-positive denominator. Division by zero is not an error
 * to be reported at this level - it is `undefined_zero_denominator`, and the
 * caller is the only place that knows that.
 */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  // `(2m + d) / 2d` in integer division is exactly "round half away from zero"
  // for a non-negative magnitude, without ever forming a fraction.
  const quotient = (2n * magnitude + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

/**
 * `numerator / denominator`, scaled to `places` decimal places and rounded
 * half away from zero. The result is an integer count of `10^-places` units.
 */
export function scaledQuotient(
  numerator: bigint,
  denominator: bigint,
  places: number = DECIMAL_PLACES,
): bigint | null {
  return divideHalfUp(numerator * decimalScale(places), denominator);
}

/**
 * Renders a scaled integer as a fixed-point decimal string.
 *
 * `formatFixed(13300000n, 6)` is `"13.300000"`. The trailing zeros are kept:
 * a fixed number of places means the string can be compared, sorted and parsed
 * without the reader having to know how many digits it happened to need.
 */
export function formatFixed(scaled: bigint, places: number = DECIMAL_PLACES): string {
  if (!Number.isInteger(places) || places < 0 || places > 18) return scaled.toString();
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const whole = places === 0 ? digits : digits.slice(0, digits.length - places);
  const fraction = places === 0 ? '' : `.${digits.slice(digits.length - places)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

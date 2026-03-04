import { COLLATERAL_SCALE } from "./constants.js";

// ============================================================
// Smart Money Flow — accuracy, timing, and PnL utilities
// ============================================================

/**
 * Compute accuracy percentage from correct predictions and total resolved.
 * Returns 0-100 as a decimal (e.g. 65.5).
 */
export function computeAccuracy(
  correctPredictions: bigint,
  totalMarketsResolved: bigint,
): number {
  if (totalMarketsResolved === 0n) return 0;
  return Number((correctPredictions * 10000n) / totalMarketsResolved) / 100;
}

/**
 * Compute entry timing score relative to median entry.
 * Lower score = earlier entry. Score < 1.0 means earlier than median.
 */
export function computeEntryTimingScore(
  entryTimestamp: bigint,
  medianTimestamp: bigint,
): number {
  if (medianTimestamp === 0n) return 0;
  return Number((entryTimestamp * 10000n) / medianTimestamp) / 10000;
}

/**
 * Determine if a position was correct based on market resolution payouts.
 * For a binary market: payouts[0] > 0 means YES won, payouts[1] > 0 means NO won.
 */
export function isPositionCorrect(
  side: string,
  payouts: bigint[],
): boolean {
  if (!payouts || payouts.length < 2) return false;
  const denominator = payouts.reduce((sum, v) => sum + v, 0n);
  if (denominator === 0n) return false;

  if (side === "YES") {
    return payouts[0]! > 0n && payouts[0]! >= payouts[1]!;
  } else {
    return payouts[1]! > 0n && payouts[1]! >= payouts[0]!;
  }
}

/**
 * Compute PnL at resolution based on entry price, position size, and payouts.
 * payoutPrice = payoutNumerator * COLLATERAL_SCALE / payoutDenominator
 * pnl = positionSize * (payoutPrice - entryPrice) / COLLATERAL_SCALE
 */
export function computeResolutionPnl(
  side: string,
  entryPrice: bigint,
  positionSize: bigint,
  payouts: bigint[],
): bigint {
  if (!payouts || payouts.length < 2) return 0n;
  const denominator = payouts.reduce((sum, v) => sum + v, 0n);
  if (denominator === 0n) return 0n;

  const outcomeIndex = side === "YES" ? 0 : 1;
  const payoutPrice =
    (payouts[outcomeIndex]! * COLLATERAL_SCALE) / denominator;

  return (positionSize * (payoutPrice - entryPrice)) / COLLATERAL_SCALE;
}

/**
 * Determine if a wallet qualifies as "smart money".
 * Criteria: accuracy > 65% AND totalMarketsResolved > 10
 */
export function checkIsSmartMoney(
  accuracy: number,
  totalMarketsResolved: bigint,
): boolean {
  return accuracy > 65 && totalMarketsResolved > 10n;
}

/**
 * Determine the winning outcome from payouts array.
 * Returns "YES" if outcome 0 won, "NO" if outcome 1 won, "DRAW" if tied.
 */
export function getWinningOutcome(payouts: bigint[]): string {
  if (!payouts || payouts.length < 2) return "UNKNOWN";
  if (payouts[0]! > payouts[1]!) return "YES";
  if (payouts[1]! > payouts[0]!) return "NO";
  return "DRAW";
}

/**
 * Compute a running average timestamp used as a median approximation.
 * newMedian = (oldMedian * (count - 1) + newTimestamp) / count
 */
export function updateMedianTimestamp(
  currentMedian: bigint,
  newTimestamp: bigint,
  totalEntrants: bigint,
): bigint {
  if (totalEntrants <= 1n) return newTimestamp;
  return (
    (currentMedian * (totalEntrants - 1n) + newTimestamp) / totalEntrants
  );
}

import { COLLATERAL_SCALE_DEC } from "./constants.js";

/**
 * Market microstructure utilities for OHLCV, spread, VWAP, and impact analysis.
 */

// Orders above this USDC threshold (raw, 6 decimals) trigger MarketImpactEvent tracking
// 10,000 USDC = 10_000 * 1_000_000
export const MARKET_IMPACT_THRESHOLD = 10_000n * 1_000_000n;

/** Round a unix timestamp (seconds) down to the start of its hour. */
export function getHourBucket(timestamp: number): number {
  return Math.floor(timestamp / 3600) * 3600;
}

/** Round a unix timestamp (seconds) down to the start of its day (UTC). */
export function getDayBucket(timestamp: number): number {
  return Math.floor(timestamp / 86400) * 86400;
}

/**
 * Compute a human-readable price from a fill.
 *
 * In Polymarket's Exchange contract one side of every fill is always USDC
 * (asset ID 0) and the other is the position token. A "buy" (makerAssetId === 0)
 * means the maker is paying USDC, so:
 *   price = makerAmountFilled / takerAmountFilled  (USDC per token)
 *
 * A "sell" (makerAssetId !== 0) means the maker is offering tokens and receiving
 * USDC, so:
 *   price = takerAmountFilled / makerAmountFilled  (USDC per token)
 *
 * Returns a floating-point number scaled to USDC (e.g. 0.65 = 65 cents).
 */
export function computePrice(
  makerAmountFilled: bigint,
  takerAmountFilled: bigint,
  makerAssetId: bigint,
): number {
  if (makerAmountFilled === 0n || takerAmountFilled === 0n) return 0;

  // makerAssetId === 0  →  maker pays USDC (buy)
  // otherwise           →  maker pays tokens (sell), receives USDC
  if (makerAssetId === 0n) {
    // USDC amount = makerAmountFilled, token amount = takerAmountFilled
    return Number(makerAmountFilled) / Number(takerAmountFilled);
  } else {
    // USDC amount = takerAmountFilled, token amount = makerAmountFilled
    return Number(takerAmountFilled) / Number(makerAmountFilled);
  }
}

/** Price impact in basis points: |priceAfter - priceBefore| / priceBefore * 10000 */
export function computePriceImpactBps(
  priceBefore: number,
  priceAfter: number,
): number {
  if (priceBefore === 0) return 0;
  return Math.round((Math.abs(priceAfter - priceBefore) / priceBefore) * 10_000);
}

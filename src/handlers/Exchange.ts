import { Exchange, type Orderbook, type OrdersMatchedGlobal } from "generated";
import {
  parseOrderFilled,
  updateUserPositionWithBuy,
  updateUserPositionWithSell,
} from "../utils/pnl.js";
import { COLLATERAL_SCALE } from "../utils/constants.js";
import {
  computePrice,
  computePriceImpactBps,
  getHourBucket,
  getDayBucket,
  MARKET_IMPACT_THRESHOLD,
} from "../utils/microstructure.js";

const TRADE_TYPE_BUY = "Buy";
const TRADE_TYPE_SELL = "Sell";
const COLLATERAL_SCALE_DEC = 1_000_000;

function getOrderSide(makerAssetId: bigint): string {
  return makerAssetId === 0n ? TRADE_TYPE_BUY : TRADE_TYPE_SELL;
}

function getOrderSize(
  makerAmountFilled: bigint,
  takerAmountFilled: bigint,
  side: string,
): bigint {
  return side === TRADE_TYPE_BUY ? makerAmountFilled : takerAmountFilled;
}

function scaleBigInt(value: bigint): number {
  return Number(value) / COLLATERAL_SCALE_DEC;
}

async function getOrCreateOrderbook(
  context: any,
  tokenId: string,
): Promise<Orderbook> {
  const existing = await context.Orderbook.get(tokenId);
  if (existing) return existing;
  return {
    id: tokenId,
    tradesQuantity: 0n,
    buysQuantity: 0n,
    sellsQuantity: 0n,
    collateralVolume: 0n,
    scaledCollateralVolume: 0,
    collateralBuyVolume: 0n,
    scaledCollateralBuyVolume: 0,
    collateralSellVolume: 0n,
    scaledCollateralSellVolume: 0,
  };
}

async function getOrCreateGlobal(
  context: any,
): Promise<OrdersMatchedGlobal> {
  const existing = await context.OrdersMatchedGlobal.get("");
  if (existing) return existing;
  return {
    id: "",
    tradesQuantity: 0n,
    buysQuantity: 0n,
    sellsQuantity: 0n,
    collateralVolume: 0,
    scaledCollateralVolume: 0,
    collateralBuyVolume: 0,
    scaledCollateralBuyVolume: 0,
    collateralSellVolume: 0,
    scaledCollateralSellVolume: 0,
  };
}

// ============================================================
// OrderFilled — individual order fill records + orderbook updates
//               + microstructure analytics
// ============================================================

Exchange.OrderFilled.handler(async ({ event, context }) => {
  const makerAssetId = event.params.makerAssetId;
  const takerAssetId = event.params.takerAssetId;
  const side = getOrderSide(makerAssetId);
  const size = getOrderSize(
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    side,
  );

  const tokenId =
    side === TRADE_TYPE_BUY ? takerAssetId.toString() : makerAssetId.toString();

  // Record OrderFilledEvent
  const eventId = `${event.transaction.hash}_${event.params.orderHash}`;
  context.OrderFilledEvent.set({
    id: eventId,
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    orderHash: event.params.orderHash,
    maker: event.params.maker,
    taker: event.params.taker,
    makerAssetId: makerAssetId.toString(),
    takerAssetId: takerAssetId.toString(),
    makerAmountFilled: event.params.makerAmountFilled,
    takerAmountFilled: event.params.takerAmountFilled,
    fee: event.params.fee,
  });

  // Update Orderbook
  const orderbook = await getOrCreateOrderbook(context, tokenId);
  const newVolume = orderbook.collateralVolume + size;

  if (side === TRADE_TYPE_BUY) {
    const newBuyVol = orderbook.collateralBuyVolume + size;
    context.Orderbook.set({
      ...orderbook,
      collateralVolume: newVolume,
      scaledCollateralVolume: scaleBigInt(newVolume),
      tradesQuantity: orderbook.tradesQuantity + 1n,
      buysQuantity: orderbook.buysQuantity + 1n,
      collateralBuyVolume: newBuyVol,
      scaledCollateralBuyVolume: scaleBigInt(newBuyVol),
    });
  } else {
    const newSellVol = orderbook.collateralSellVolume + size;
    context.Orderbook.set({
      ...orderbook,
      collateralVolume: newVolume,
      scaledCollateralVolume: scaleBigInt(newVolume),
      tradesQuantity: orderbook.tradesQuantity + 1n,
      sellsQuantity: orderbook.sellsQuantity + 1n,
      collateralSellVolume: newSellVol,
      scaledCollateralSellVolume: scaleBigInt(newSellVol),
    });
  }

  // PnL: Update user position based on order fill
  const order = parseOrderFilled(event.params);
  const price =
    order.baseAmount > 0n
      ? (order.quoteAmount * COLLATERAL_SCALE) / order.baseAmount
      : 0n;

  if (order.side === "BUY") {
    await updateUserPositionWithBuy(
      context,
      order.account,
      order.positionId,
      price,
      order.baseAmount,
    );
  } else {
    await updateUserPositionWithSell(
      context,
      order.account,
      order.positionId,
      price,
      order.baseAmount,
    );
  }

  // ============================================================
  // Microstructure analytics
  // ============================================================

  const fillPrice = computePrice(
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    makerAssetId,
  );
  if (fillPrice === 0) return;

  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const volumeScaled = scaleBigInt(size);

  // Look up conditionId from MarketData (may be undefined for unregistered tokens)
  const marketData = await context.MarketData.get(tokenId);
  const conditionId = marketData ? marketData.condition : "";

  // --- MarketTick (OHLCV per block) ---
  const tickId = `${tokenId}-${blockNumber}`;
  const existingTick = await context.MarketTick.get(tickId);

  if (existingTick) {
    context.MarketTick.set({
      ...existingTick,
      closePrice: fillPrice,
      highPrice: Math.max(existingTick.highPrice, fillPrice),
      lowPrice: Math.min(existingTick.lowPrice, fillPrice),
      volume: existingTick.volume + volumeScaled,
      numFills: existingTick.numFills + 1n,
    });
  } else {
    context.MarketTick.set({
      id: tickId,
      tokenId,
      conditionId,
      blockNumber: BigInt(blockNumber),
      timestamp: BigInt(timestamp),
      price: fillPrice,
      volume: volumeScaled,
      side: side === TRADE_TYPE_BUY ? "BUY" : "SELL",
      numFills: 1n,
      highPrice: fillPrice,
      lowPrice: fillPrice,
      openPrice: fillPrice,
      closePrice: fillPrice,
    });
  }

  // --- SpreadTracker (hourly spread estimation) ---
  // Spread is estimated from the difference between the latest buy and sell
  // prices within the same hour. We track the most recent buy/sell price
  // via the MarketTick data and compute spread when we see alternating sides.
  const hourBucket = getHourBucket(timestamp);
  const spreadId = `${tokenId}-${hourBucket}`;
  const existingSpread = await context.SpreadTracker.get(spreadId);

  // We estimate spread by looking at the previous tick's close price for
  // a different side. As a simple heuristic, any price difference from
  // consecutive fills approximates half-spread * 2.
  if (existingTick && existingTick.closePrice !== fillPrice) {
    const spreadEstimate = Math.abs(fillPrice - existingTick.closePrice);

    if (existingSpread) {
      const newCount = existingSpread.spreadSampleCount + 1n;
      const newAvg =
        (existingSpread.avgSpread * Number(existingSpread.spreadSampleCount) +
          spreadEstimate) /
        Number(newCount);
      context.SpreadTracker.set({
        ...existingSpread,
        avgSpread: newAvg,
        minSpread: Math.min(existingSpread.minSpread, spreadEstimate),
        maxSpread: Math.max(existingSpread.maxSpread, spreadEstimate),
        spreadSampleCount: newCount,
      });
    } else {
      context.SpreadTracker.set({
        id: spreadId,
        tokenId,
        hourTimestamp: BigInt(hourBucket),
        avgSpread: spreadEstimate,
        minSpread: spreadEstimate,
        maxSpread: spreadEstimate,
        spreadSampleCount: 1n,
      });
    }
  } else if (!existingSpread) {
    // Initialize spread tracker even without a sample yet
    context.SpreadTracker.set({
      id: spreadId,
      tokenId,
      hourTimestamp: BigInt(hourBucket),
      avgSpread: 0,
      minSpread: 0,
      maxSpread: 0,
      spreadSampleCount: 0n,
    });
  }

  // --- VWAPTracker (daily VWAP) ---
  const dayBucket = getDayBucket(timestamp);
  const vwapId = `${tokenId}-${dayBucket}`;
  const existingVwap = await context.VWAPTracker.get(vwapId);

  const tradeValue = fillPrice * volumeScaled;

  if (existingVwap) {
    const newTotalVolume = existingVwap.totalVolume + volumeScaled;
    const newTotalValue = existingVwap.totalValueTraded + tradeValue;
    context.VWAPTracker.set({
      ...existingVwap,
      totalVolume: newTotalVolume,
      totalValueTraded: newTotalValue,
      vwap: newTotalVolume > 0 ? newTotalValue / newTotalVolume : 0,
    });
  } else {
    context.VWAPTracker.set({
      id: vwapId,
      tokenId,
      dayTimestamp: BigInt(dayBucket),
      vwap: fillPrice,
      totalVolume: volumeScaled,
      totalValueTraded: tradeValue,
    });
  }

  // --- MakerTakerFlow (hourly maker/taker classification) ---
  // In Polymarket's CLOB, the maker is the limit order poster and the
  // taker is the order that crosses the spread (market order).
  const flowId = `${tokenId}-${hourBucket}`;
  const existingFlow = await context.MakerTakerFlow.get(flowId);

  const isBuy = side === TRADE_TYPE_BUY;
  const makerBuyVol = isBuy ? volumeScaled : 0;
  const makerSellVol = isBuy ? 0 : volumeScaled;
  const takerBuyVol = isBuy ? 0 : volumeScaled;
  const takerSellVol = isBuy ? volumeScaled : 0;

  if (existingFlow) {
    const newMakerBuy = existingFlow.makerBuyVolume + makerBuyVol;
    const newMakerSell = existingFlow.makerSellVolume + makerSellVol;
    const newTakerBuy = existingFlow.takerBuyVolume + takerBuyVol;
    const newTakerSell = existingFlow.takerSellVolume + takerSellVol;
    context.MakerTakerFlow.set({
      ...existingFlow,
      makerBuyVolume: newMakerBuy,
      makerSellVolume: newMakerSell,
      takerBuyVolume: newTakerBuy,
      takerSellVolume: newTakerSell,
      netMakerFlow: (newMakerBuy + newMakerSell) - (newTakerBuy + newTakerSell),
      numMakerOrders: existingFlow.numMakerOrders + 1n,
      numTakerOrders: existingFlow.numTakerOrders + 1n,
    });
  } else {
    context.MakerTakerFlow.set({
      id: flowId,
      tokenId,
      hourTimestamp: BigInt(hourBucket),
      makerBuyVolume: makerBuyVol,
      makerSellVolume: makerSellVol,
      takerBuyVolume: takerBuyVol,
      takerSellVolume: takerSellVol,
      netMakerFlow: (makerBuyVol + makerSellVol) - (takerBuyVol + takerSellVol),
      numMakerOrders: 1n,
      numTakerOrders: 1n,
    });
  }

  // --- MarketImpactEvent (large orders only) ---
  // Compute USDC size of this order for threshold check
  const usdcSize = makerAssetId === 0n
    ? event.params.makerAmountFilled
    : event.params.takerAmountFilled;

  if (usdcSize >= MARKET_IMPACT_THRESHOLD && existingTick) {
    const priceBefore = existingTick.closePrice;
    const priceAfter = fillPrice;
    const impactBps = computePriceImpactBps(priceBefore, priceAfter);

    const impactId = `${event.transaction.hash}_${event.logIndex}`;
    context.MarketImpactEvent.set({
      id: impactId,
      tokenId,
      timestamp: BigInt(timestamp),
      orderSize: scaleBigInt(usdcSize),
      priceBeforeFill: priceBefore,
      priceAfterFill: priceAfter,
      priceImpactBps: BigInt(impactBps),
      txHash: event.transaction.hash,
    });
  }
});

// ============================================================
// OrdersMatched — batch match records + global volume
// ============================================================

Exchange.OrdersMatched.handler(async ({ event, context }) => {
  // Note: In the original subgraph, amounts are swapped for OrdersMatched
  const makerAmountFilled = event.params.takerAmountFilled;
  const takerAmountFilled = event.params.makerAmountFilled;
  const side = getOrderSide(event.params.makerAssetId);
  const size = getOrderSize(makerAmountFilled, takerAmountFilled, side);

  // Record OrdersMatchedEvent
  context.OrdersMatchedEvent.set({
    id: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    makerAssetID: event.params.makerAssetId,
    takerAssetID: event.params.takerAssetId,
    makerAmountFilled: event.params.makerAmountFilled,
    takerAmountFilled: event.params.takerAmountFilled,
  });

  // Update global volume
  const global = await getOrCreateGlobal(context);
  const sizeNum = Number(size) / COLLATERAL_SCALE_DEC;
  const newVolume = global.collateralVolume + sizeNum;

  if (side === TRADE_TYPE_BUY) {
    const newBuyVol = global.collateralBuyVolume + sizeNum;
    context.OrdersMatchedGlobal.set({
      ...global,
      tradesQuantity: global.tradesQuantity + 1n,
      collateralVolume: newVolume,
      scaledCollateralVolume: newVolume,
      buysQuantity: global.buysQuantity + 1n,
      collateralBuyVolume: newBuyVol,
      scaledCollateralBuyVolume: newBuyVol,
    });
  } else {
    const newSellVol = global.collateralSellVolume + sizeNum;
    context.OrdersMatchedGlobal.set({
      ...global,
      tradesQuantity: global.tradesQuantity + 1n,
      collateralVolume: newVolume,
      scaledCollateralVolume: newVolume,
      sellsQuantity: global.sellsQuantity + 1n,
      collateralSellVolume: newSellVol,
      scaledCollateralSellVolume: newSellVol,
    });
  }
});

// ============================================================
// TokenRegistered — link token IDs to conditions
// ============================================================

Exchange.TokenRegistered.handler(async ({ event, context }) => {
  const token0Str = event.params.token0.toString();
  const token1Str = event.params.token1.toString();
  const condition = event.params.conditionId;

  const data0 = await context.MarketData.get(token0Str);
  if (!data0) {
    context.MarketData.set({
      id: token0Str,
      condition,
      outcomeIndex: undefined,
    });
  }

  const data1 = await context.MarketData.get(token1Str);
  if (!data1) {
    context.MarketData.set({
      id: token1Str,
      condition,
      outcomeIndex: undefined,
    });
  }
});

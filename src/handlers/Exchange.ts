import { Exchange, type Orderbook, type OrdersMatchedGlobal } from "generated";
import {
  parseOrderFilled,
  updateUserPositionWithBuy,
  updateUserPositionWithSell,
} from "../utils/pnl.js";
import { COLLATERAL_SCALE } from "../utils/constants.js";
import { updateMedianTimestamp } from "../utils/smartMoney.js";

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
// + Smart Money Flow: EarlyPosition, MarketEntryTimeline,
//   WalletScore, SmartMoneyAlert
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
  // Smart Money Flow: Track early positions and wallet scores
  // CROSS-ENTITY: This reads MarketData (Exchange), Position (CTF),
  // WalletScore, EarlyPosition, and MarketEntryTimeline — only
  // possible because this unified indexer combines all subgraphs.
  // ============================================================

  // Only track BUY orders for smart money (entering positions)
  if (order.side !== "BUY") return;

  const walletAddress = order.account;
  const timestamp = BigInt(event.block.timestamp);

  // CROSS-ENTITY: Read MarketData (from Exchange.TokenRegistered) to get conditionId
  const marketData = await context.MarketData.get(tokenId);
  if (!marketData) return; // Token not registered yet

  const conditionId = marketData.condition;

  // CROSS-ENTITY: Read Position (from ConditionalTokens.ConditionPreparation) to get outcome side
  const position = await context.Position.get(tokenId);
  const positionSide = position
    ? position.outcomeIndex === 0n
      ? "YES"
      : "NO"
    : "YES"; // Default YES if position not found

  // Update or create MarketEntryTimeline for this condition
  const earlyPositionId = `${walletAddress}-${conditionId}`;
  const existingPosition = await context.EarlyPosition.get(earlyPositionId);
  const isNewEntry = !existingPosition;

  let timeline = await context.MarketEntryTimeline.get(conditionId);
  if (!timeline) {
    timeline = {
      id: conditionId,
      conditionId,
      totalEntrants: 0n,
      firstEntryTimestamp: timestamp,
      medianEntryTimestamp: timestamp,
      resolutionTimestamp: undefined,
      winningOutcome: undefined,
    };
  }

  let entryRank = existingPosition ? existingPosition.entryRank : 0n;

  if (isNewEntry) {
    // New entrant — increment timeline and assign rank
    const newTotal = timeline.totalEntrants + 1n;
    const newMedian = updateMedianTimestamp(
      timeline.medianEntryTimestamp,
      timestamp,
      newTotal,
    );
    entryRank = newTotal;

    context.MarketEntryTimeline.set({
      ...timeline,
      totalEntrants: newTotal,
      firstEntryTimestamp:
        timestamp < timeline.firstEntryTimestamp
          ? timestamp
          : timeline.firstEntryTimestamp,
      medianEntryTimestamp: newMedian,
    });
  }

  // Create or update EarlyPosition
  if (existingPosition) {
    // Accumulate position: weighted avg entry price, add to position size
    const totalSize = existingPosition.positionSize + order.baseAmount;
    const weightedPrice =
      totalSize > 0n
        ? (existingPosition.entryPrice * existingPosition.positionSize +
            price * order.baseAmount) /
          totalSize
        : price;

    context.EarlyPosition.set({
      ...existingPosition,
      entryPrice: weightedPrice,
      positionSize: totalSize,
    });
  } else {
    context.EarlyPosition.set({
      id: earlyPositionId,
      walletAddress,
      conditionId,
      entryTimestamp: timestamp,
      entryPrice: price,
      side: positionSide,
      positionSize: order.baseAmount,
      marketResolutionTimestamp: undefined,
      outcome: undefined,
      pnl: undefined,
      entryRank,
    });
  }

  // CROSS-ENTITY: Read/update WalletScore — tracks lifetime stats across
  // Wallet creation, Exchange orders, CTF positions, and Oracle resolution
  let walletScore = await context.WalletScore.get(walletAddress);
  if (!walletScore) {
    walletScore = {
      id: walletAddress,
      totalMarketsEntered: 0n,
      totalMarketsResolved: 0n,
      correctPredictions: 0n,
      incorrectPredictions: 0n,
      accuracy: 0,
      avgEntryTiming: 0,
      totalProfitUSDC: 0n,
      totalLossUSDC: 0n,
      netPnl: 0n,
      currentOpenPositions: 0n,
      lastActivityTimestamp: timestamp,
      walletAge: timestamp,
      isSmartMoney: false,
    };
  }

  if (isNewEntry) {
    context.WalletScore.set({
      ...walletScore,
      totalMarketsEntered: walletScore.totalMarketsEntered + 1n,
      currentOpenPositions: walletScore.currentOpenPositions + 1n,
      lastActivityTimestamp: timestamp,
    });
  } else {
    context.WalletScore.set({
      ...walletScore,
      lastActivityTimestamp: timestamp,
    });
  }

  // SmartMoneyAlert: If this wallet is flagged as smart money, create an alert
  // CROSS-ENTITY: Uses WalletScore (aggregated from Oracle + CTF + Exchange data)
  // to decide if this new position is noteworthy.
  // Demo: "This wallet has been right on 47/50 markets and just bought YES on [current market]."
  if (walletScore.isSmartMoney) {
    const alertId = `${event.chainId}-${event.block.number}-${event.logIndex}`;
    context.SmartMoneyAlert.set({
      id: alertId,
      walletAddress,
      conditionId,
      tokenId,
      side: positionSide,
      size: order.baseAmount,
      price,
      timestamp,
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

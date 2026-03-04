import { UmaSportsOracle } from "generated";
import {
  computeAccuracy,
  computeEntryTimingScore,
  computeResolutionPnl,
  isPositionCorrect,
  checkIsSmartMoney,
  getWinningOutcome,
} from "../utils/smartMoney.js";

// State constants
const GameStateCreated = "Created";
const GameStateSettled = "Settled";
const GameStateCanceled = "Canceled";
const GameStatePaused = "Paused";
const GameStateEmergencySettled = "EmergencySettled";

const MarketStateCreated = "Created";
const MarketStateResolved = "Resolved";
const MarketStatePaused = "Paused";
const MarketStateEmergencyResolved = "EmergencyResolved";

// Enum mappers
function getMarketType(marketTypeEnum: bigint): string {
  if (marketTypeEnum === 0n) return "moneyline";
  if (marketTypeEnum === 1n) return "spreads";
  return "totals";
}

function getGameOrdering(gameOrderingEnum: bigint): string {
  return gameOrderingEnum === 0n ? "home" : "away";
}

function getMarketUnderdog(underdogEnum: bigint): string {
  return underdogEnum === 0n ? "home" : "away";
}

// ============================================================
// Game event handlers
// ============================================================

UmaSportsOracle.GameCreated.handler(async ({ event, context }) => {
  const gameId = event.params.gameId.toLowerCase();
  context.Game.set({
    id: gameId,
    ancillaryData: event.params.ancillaryData,
    ordering: getGameOrdering(event.params.ordering),
    state: GameStateCreated,
    homeScore: 0n,
    awayScore: 0n,
  });
});

UmaSportsOracle.GameSettled.handler(async ({ event, context }) => {
  const gameId = event.params.gameId.toLowerCase();
  const game = await context.Game.get(gameId);
  if (!game) {
    context.log.error(`Game not found: ${gameId}`);
    return;
  }
  context.Game.set({
    ...game,
    state: GameStateSettled,
    homeScore: event.params.home,
    awayScore: event.params.away,
  });
});

UmaSportsOracle.GameEmergencySettled.handler(async ({ event, context }) => {
  const gameId = event.params.gameId.toLowerCase();
  const game = await context.Game.get(gameId);
  if (!game) {
    context.log.error(`Game not found: ${gameId}`);
    return;
  }
  context.Game.set({
    ...game,
    state: GameStateEmergencySettled,
    homeScore: event.params.home,
    awayScore: event.params.away,
  });
});

UmaSportsOracle.GameCanceled.handler(async ({ event, context }) => {
  const gameId = event.params.gameId.toLowerCase();
  const game = await context.Game.get(gameId);
  if (!game) {
    context.log.error(`Game not found: ${gameId}`);
    return;
  }
  context.Game.set({
    ...game,
    state: GameStateCanceled,
  });
});

UmaSportsOracle.GamePaused.handler(async ({ event, context }) => {
  const gameId = event.params.gameId.toLowerCase();
  const game = await context.Game.get(gameId);
  if (!game) {
    context.log.error(`Game not found: ${gameId}`);
    return;
  }
  context.Game.set({
    ...game,
    state: GameStatePaused,
  });
});

UmaSportsOracle.GameUnpaused.handler(async ({ event, context }) => {
  const gameId = event.params.gameId.toLowerCase();
  const game = await context.Game.get(gameId);
  if (!game) {
    context.log.error(`Game not found: ${gameId}`);
    return;
  }
  context.Game.set({
    ...game,
    state: GameStateCreated, // Unpaused reverts to Created state
  });
});

// ============================================================
// Market event handlers
// ============================================================

UmaSportsOracle.MarketCreated.handler(async ({ event, context }) => {
  const marketId = event.params.marketId.toLowerCase();
  context.Market.set({
    id: marketId,
    gameId: event.params.gameId.toLowerCase(),
    conditionId: event.params.conditionId,
    state: MarketStateCreated,
    marketType: getMarketType(event.params.marketType),
    underdog: getMarketUnderdog(event.params.underdog),
    line: event.params.line,
    payouts: [],
  });
});

// ============================================================
// MarketResolved — resolve market + Smart Money Flow scoring
// CROSS-ENTITY: This handler reads Market (Oracle), EarlyPosition
// (Exchange), MarketEntryTimeline (Exchange), and WalletScore
// (aggregated across all subgraphs) to score wallet accuracy.
// This is only possible in a unified indexer that combines Oracle
// resolution data with Exchange trading data.
// ============================================================

UmaSportsOracle.MarketResolved.handler(async ({ event, context }) => {
  const marketId = event.params.marketId.toLowerCase();
  const market = await context.Market.get(marketId);
  if (!market) {
    context.log.error(`Market not found: ${marketId}`);
    return;
  }

  const payouts = event.params.payouts;

  context.Market.set({
    ...market,
    state: MarketStateResolved,
    payouts,
  });

  // ============================================================
  // Smart Money Flow: Resolve all EarlyPositions for this condition
  // CROSS-ENTITY: Uses conditionId from Market (Oracle) to find
  // EarlyPositions (Exchange) and update WalletScores (unified).
  // ============================================================

  const conditionId = market.conditionId;
  const resolutionTimestamp = BigInt(event.block.timestamp);
  const winningOutcome = getWinningOutcome(payouts);

  // Update MarketEntryTimeline with resolution data
  const timeline = await context.MarketEntryTimeline.get(conditionId);
  if (timeline) {
    context.MarketEntryTimeline.set({
      ...timeline,
      resolutionTimestamp,
      winningOutcome,
    });
  }

  // Look up all EarlyPositions for this condition to score them
  // CROSS-ENTITY: getWhere queries EarlyPosition (created in Exchange handler)
  // using conditionId from the Oracle's Market entity
  const earlyPositions = await context.EarlyPosition.getWhere({ conditionId: { _eq: conditionId } });

  for (const ep of earlyPositions) {
    const correct = isPositionCorrect(ep.side, payouts);
    const pnl = computeResolutionPnl(ep.side, ep.entryPrice, ep.positionSize, payouts);
    const outcome = correct ? "WIN" : "LOSS";

    // Update EarlyPosition with resolution outcome
    context.EarlyPosition.set({
      ...ep,
      marketResolutionTimestamp: resolutionTimestamp,
      outcome,
      pnl,
    });

    // CROSS-ENTITY: Update WalletScore using resolution data from Oracle
    // combined with position data from Exchange
    const walletScore = await context.WalletScore.get(ep.walletAddress);
    if (!walletScore) continue;

    const newResolved = walletScore.totalMarketsResolved + 1n;
    const newCorrect = correct
      ? walletScore.correctPredictions + 1n
      : walletScore.correctPredictions;
    const newIncorrect = correct
      ? walletScore.incorrectPredictions
      : walletScore.incorrectPredictions + 1n;
    const newAccuracy = computeAccuracy(newCorrect, newResolved);

    // Compute entry timing score relative to market median
    const entryTimingScore = timeline
      ? computeEntryTimingScore(ep.entryTimestamp, timeline.medianEntryTimestamp)
      : 0;
    // Running average of entry timing scores
    const newAvgTiming =
      newResolved > 1n
        ? (walletScore.avgEntryTiming * Number(newResolved - 1n) + entryTimingScore) /
          Number(newResolved)
        : entryTimingScore;

    const newProfit = pnl > 0n ? walletScore.totalProfitUSDC + pnl : walletScore.totalProfitUSDC;
    const newLoss = pnl < 0n ? walletScore.totalLossUSDC + (-pnl) : walletScore.totalLossUSDC;
    const newNetPnl = walletScore.netPnl + pnl;
    const newOpenPositions = walletScore.currentOpenPositions > 0n
      ? walletScore.currentOpenPositions - 1n
      : 0n;

    context.WalletScore.set({
      ...walletScore,
      totalMarketsResolved: newResolved,
      correctPredictions: newCorrect,
      incorrectPredictions: newIncorrect,
      accuracy: newAccuracy,
      avgEntryTiming: newAvgTiming,
      totalProfitUSDC: newProfit,
      totalLossUSDC: newLoss,
      netPnl: newNetPnl,
      currentOpenPositions: newOpenPositions,
      isSmartMoney: checkIsSmartMoney(newAccuracy, newResolved),
    });
  }
});

UmaSportsOracle.MarketEmergencyResolved.handler(
  async ({ event, context }) => {
    const marketId = event.params.marketId.toLowerCase();
    const market = await context.Market.get(marketId);
    if (!market) {
      context.log.error(`Market not found: ${marketId}`);
      return;
    }
    context.Market.set({
      ...market,
      state: MarketStateEmergencyResolved,
      payouts: event.params.payouts,
    });
  },
);

UmaSportsOracle.MarketPaused.handler(async ({ event, context }) => {
  const marketId = event.params.marketId.toLowerCase();
  const market = await context.Market.get(marketId);
  if (!market) {
    context.log.error(`Market not found: ${marketId}`);
    return;
  }
  context.Market.set({
    ...market,
    state: MarketStatePaused,
  });
});

UmaSportsOracle.MarketUnpaused.handler(async ({ event, context }) => {
  const marketId = event.params.marketId.toLowerCase();
  const market = await context.Market.get(marketId);
  if (!market) {
    context.log.error(`Market not found: ${marketId}`);
    return;
  }
  context.Market.set({
    ...market,
    state: MarketStateCreated, // Unpaused reverts to Created state
  });
});

import { NegRiskAdapter } from "generated";
import {
  NEG_RISK_ADAPTER,
  NEG_RISK_EXCHANGE,
} from "../utils/constants.js";
import {
  getEventKey,
  getNegRiskQuestionId,
  getConditionId,
  indexSetContains,
} from "../utils/negRisk.js";

const NEG_RISK_EXCHANGE_LOWER = NEG_RISK_EXCHANGE.toLowerCase();
const FEE_DENOMINATOR = 10_000n;

// ============================================================
// Helper: get or create OI entities
// ============================================================

async function getOrCreateMarketOI(
  context: any,
  conditionId: string,
): Promise<{ id: string; amount: bigint }> {
  const existing = await context.MarketOpenInterest.get(conditionId);
  if (existing) return existing;
  return { id: conditionId, amount: 0n };
}

async function getOrCreateGlobalOI(
  context: any,
): Promise<{ id: string; amount: bigint }> {
  const existing = await context.GlobalOpenInterest.get("");
  if (existing) return existing;
  return { id: "", amount: 0n };
}

async function updateMarketOI(
  context: any,
  conditionId: string,
  amount: bigint,
): Promise<void> {
  const marketOI = await getOrCreateMarketOI(context, conditionId);
  context.MarketOpenInterest.set({
    ...marketOI,
    amount: marketOI.amount + amount,
  });
}

async function updateGlobalOI(
  context: any,
  amount: bigint,
): Promise<void> {
  const globalOI = await getOrCreateGlobalOI(context);
  context.GlobalOpenInterest.set({
    ...globalOI,
    amount: globalOI.amount + amount,
  });
}

async function updateOpenInterest(
  context: any,
  conditionId: string,
  amount: bigint,
): Promise<void> {
  await updateMarketOI(context, conditionId, amount);
  await updateGlobalOI(context, amount);
}

// ============================================================
// MarketPrepared — create NegRiskEvent
// ============================================================

NegRiskAdapter.MarketPrepared.handler(async ({ event, context }) => {
  context.NegRiskEvent.set({
    id: event.params.marketId,
    feeBps: event.params.feeBips,
    questionCount: 0n,
  });
});

// ============================================================
// QuestionPrepared — increment NegRiskEvent questionCount
// ============================================================

NegRiskAdapter.QuestionPrepared.handler(async ({ event, context }) => {
  const negRiskEvent = await context.NegRiskEvent.get(event.params.marketId);
  if (!negRiskEvent) return;

  context.NegRiskEvent.set({
    ...negRiskEvent,
    questionCount: negRiskEvent.questionCount + 1n,
  });
});

// ============================================================
// PositionSplit — Activity: create Split + OI: increase
// ============================================================

NegRiskAdapter.PositionSplit.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const stakeholder = event.params.stakeholder;

  // OI: Check condition exists
  const condition = await context.Condition.get(conditionId);
  if (condition) {
    await updateOpenInterest(context, conditionId, event.params.amount);
  }

  // Activity: Create Split (skip NegRiskExchange)
  if (stakeholder.toLowerCase() !== NEG_RISK_EXCHANGE_LOWER) {
    context.Split.set({
      id: getEventKey(event.chainId, event.block.number, event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      stakeholder,
      condition: conditionId,
      amount: event.params.amount,
    });
  }
});

// ============================================================
// PositionsMerge — Activity: create Merge + OI: decrease
// ============================================================

NegRiskAdapter.PositionsMerge.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const stakeholder = event.params.stakeholder;

  // OI: Check condition exists
  const condition = await context.Condition.get(conditionId);
  if (condition) {
    await updateOpenInterest(context, conditionId, -event.params.amount);
  }

  // Activity: Create Merge (skip NegRiskExchange)
  if (stakeholder.toLowerCase() !== NEG_RISK_EXCHANGE_LOWER) {
    context.Merge.set({
      id: getEventKey(event.chainId, event.block.number, event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      stakeholder,
      condition: conditionId,
      amount: event.params.amount,
    });
  }
});

// ============================================================
// PayoutRedemption — Activity: create Redemption + OI: decrease
// ============================================================

NegRiskAdapter.PayoutRedemption.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;

  // OI: Check condition exists
  const condition = await context.Condition.get(conditionId);
  if (condition) {
    await updateOpenInterest(context, conditionId, -event.params.payout);
  }

  // Activity: Create Redemption with default indexSets for binary
  context.Redemption.set({
    id: getEventKey(event.chainId, event.block.number, event.logIndex),
    timestamp: BigInt(event.block.timestamp),
    redeemer: event.params.redeemer,
    condition: conditionId,
    indexSets: [1n, 2n],
    payout: event.params.payout,
  });
});

// ============================================================
// PositionsConverted — Activity: create NegRiskConversion + OI: reduce
// ============================================================

NegRiskAdapter.PositionsConverted.handler(async ({ event, context }) => {
  const marketId = event.params.marketId;
  const negRiskEvent = await context.NegRiskEvent.get(marketId);
  if (!negRiskEvent) return;

  const questionCount = Number(negRiskEvent.questionCount);
  const indexSet = event.params.indexSet;

  // Activity: Create NegRiskConversion
  context.NegRiskConversion.set({
    id: getEventKey(event.chainId, event.block.number, event.logIndex),
    timestamp: BigInt(event.block.timestamp),
    stakeholder: event.params.stakeholder,
    negRiskMarketId: marketId,
    amount: event.params.amount,
    indexSet,
    questionCount: negRiskEvent.questionCount,
  });

  // OI: Collect condition IDs for positions being converted
  const conditionIds: string[] = [];
  for (let qi = 0; qi < questionCount; qi++) {
    if (indexSetContains(indexSet, qi)) {
      const questionId = getNegRiskQuestionId(
        marketId as `0x${string}`,
        qi,
      );
      const conditionId = getConditionId(
        NEG_RISK_ADAPTER as `0x${string}`,
        questionId,
      ).toLowerCase();
      conditionIds.push(conditionId);
    }
  }

  // Converts reduce OI when more than 1 no position
  const noCount = conditionIds.length;
  if (noCount > 1) {
    let amount = event.params.amount;
    const multiplier = BigInt(noCount - 1);
    const divisor = BigInt(noCount);

    if (negRiskEvent.feeBps > 0n) {
      const feeAmount = (amount * negRiskEvent.feeBps) / FEE_DENOMINATOR;
      amount = amount - feeAmount;

      // Reduce OI by fees released to vault
      const feeReleased = -(feeAmount * multiplier);
      for (let i = 0; i < noCount; i++) {
        await updateMarketOI(context, conditionIds[i]!, feeReleased / divisor);
      }
      await updateGlobalOI(context, feeReleased);
    }

    // Reduce OI by collateral released to user
    const collateralReleased = -(amount * multiplier);
    for (let i = 0; i < noCount; i++) {
      await updateMarketOI(
        context,
        conditionIds[i]!,
        collateralReleased / divisor,
      );
    }
    await updateGlobalOI(context, collateralReleased);
  }
});

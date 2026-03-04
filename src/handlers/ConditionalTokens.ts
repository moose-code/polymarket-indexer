import { ConditionalTokens } from "generated";
import {
  USDC,
  NEG_RISK_ADAPTER,
  EXCHANGE,
  NEG_RISK_EXCHANGE,
} from "../utils/constants.js";
import { computePositionId } from "../utils/ctf.js";
import { getEventKey } from "../utils/negRisk.js";

const USDC_LOWER = USDC.toLowerCase();
const NEG_RISK_ADAPTER_LOWER = NEG_RISK_ADAPTER.toLowerCase();
const EXCHANGE_LOWER = EXCHANGE.toLowerCase();
const NEG_RISK_EXCHANGE_LOWER = NEG_RISK_EXCHANGE.toLowerCase();

// Addresses to skip for activity tracking (handled elsewhere)
const SKIP_ACTIVITY = new Set([
  NEG_RISK_ADAPTER_LOWER,
  EXCHANGE_LOWER,
  NEG_RISK_EXCHANGE_LOWER,
]);

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

async function updateOpenInterest(
  context: any,
  conditionId: string,
  amount: bigint,
): Promise<void> {
  const marketOI = await getOrCreateMarketOI(context, conditionId);
  context.MarketOpenInterest.set({
    ...marketOI,
    amount: marketOI.amount + amount,
  });

  const globalOI = await getOrCreateGlobalOI(context);
  context.GlobalOpenInterest.set({
    ...globalOI,
    amount: globalOI.amount + amount,
  });
}

// ============================================================
// ConditionPreparation — create Condition + Position entities
// ============================================================

ConditionalTokens.ConditionPreparation.handler(async ({ event, context }) => {
  // Only handle binary conditions (2 outcomes)
  if (event.params.outcomeSlotCount !== 2n) return;

  const conditionId = event.params.conditionId;

  // Create Condition entity (OI)
  const existing = await context.Condition.get(conditionId);
  if (!existing) {
    context.Condition.set({ id: conditionId });
  }

  // Create Position entities (Activity)
  const negRisk =
    event.params.oracle.toLowerCase() === NEG_RISK_ADAPTER_LOWER;

  for (let outcomeIndex = 0; outcomeIndex < 2; outcomeIndex++) {
    const collateral = negRisk
      ? ("0x3A3BD7bb9528E159577F7C2e685CC81A765002E2" as `0x${string}`)
      : (USDC as `0x${string}`);

    const positionId = computePositionId(
      collateral,
      conditionId as `0x${string}`,
      outcomeIndex,
    );
    const posIdStr = positionId.toString();

    const existingPos = await context.Position.get(posIdStr);
    if (!existingPos) {
      context.Position.set({
        id: posIdStr,
        condition: conditionId,
        outcomeIndex: BigInt(outcomeIndex),
      });
    }
  }
});

// ============================================================
// PositionSplit — Activity: create Split + OI: increase
// ============================================================

ConditionalTokens.PositionSplit.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const stakeholder = event.params.stakeholder;
  const stakeholderLower = stakeholder.toLowerCase();
  const collateralToken = event.params.collateralToken;

  // Skip unrecognized conditions
  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  // Activity: Create Split (skip FPMMs, NegRiskAdapter, Exchange)
  if (!SKIP_ACTIVITY.has(stakeholderLower)) {
    const isFPMM = await context.FixedProductMarketMaker.get(stakeholder);
    if (!isFPMM) {
      context.Split.set({
        id: getEventKey(event.chainId, event.block.number, event.logIndex),
        timestamp: BigInt(event.block.timestamp),
        stakeholder,
        condition: conditionId,
        amount: event.params.amount,
      });
    }
  }

  // OI: Only track USDC splits (not wrapped collateral from neg risk)
  if (collateralToken.toLowerCase() === USDC_LOWER) {
    await updateOpenInterest(context, conditionId, event.params.amount);
  }
});

// ============================================================
// PositionsMerge — Activity: create Merge + OI: decrease
// ============================================================

ConditionalTokens.PositionsMerge.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const stakeholder = event.params.stakeholder;
  const stakeholderLower = stakeholder.toLowerCase();
  const collateralToken = event.params.collateralToken;

  // Skip unrecognized conditions
  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  // Activity: Create Merge (skip FPMMs, NegRiskAdapter, Exchange)
  if (!SKIP_ACTIVITY.has(stakeholderLower)) {
    const isFPMM = await context.FixedProductMarketMaker.get(stakeholder);
    if (!isFPMM) {
      context.Merge.set({
        id: getEventKey(event.chainId, event.block.number, event.logIndex),
        timestamp: BigInt(event.block.timestamp),
        stakeholder,
        condition: conditionId,
        amount: event.params.amount,
      });
    }
  }

  // OI: Only track USDC merges — merge reduces OI
  if (collateralToken.toLowerCase() === USDC_LOWER) {
    await updateOpenInterest(context, conditionId, -event.params.amount);
  }
});

// ============================================================
// PayoutRedemption — Activity: create Redemption + OI: decrease
// ============================================================

ConditionalTokens.PayoutRedemption.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const redeemer = event.params.redeemer;
  const collateralToken = event.params.collateralToken;

  // Skip unrecognized conditions
  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  // Activity: Create Redemption (skip NegRiskAdapter — handled in NRA handler)
  if (redeemer.toLowerCase() !== NEG_RISK_ADAPTER_LOWER) {
    context.Redemption.set({
      id: getEventKey(event.chainId, event.block.number, event.logIndex),
      timestamp: BigInt(event.block.timestamp),
      redeemer,
      condition: conditionId,
      indexSets: event.params.indexSets.map((v: bigint) => v),
      payout: event.params.payout,
    });
  }

  // OI: Only track USDC redemptions — redemption reduces OI
  if (collateralToken.toLowerCase() === USDC_LOWER) {
    await updateOpenInterest(context, conditionId, -event.params.payout);
  }
});

import { describe, it, expect } from "vitest";
// @ts-ignore - bignumber.js is nested in generated package
import BigNumber from "../generated/node_modules/bignumber.js/bignumber.mjs";
import {
  TestHelpers,
  type FeeRefunded,
  type Game,
  type Market,
  type Wallet,
  type Orderbook,
  type OrdersMatchedGlobal,
  type Condition,
  type NegRiskEvent,
} from "generated";

// Import handlers to register them before tests run
import "./handlers/FeeModule.js";
import "./handlers/UmaSportsOracle.js";
import "./handlers/Wallet.js";
import "./handlers/Exchange.js";
import "./handlers/ConditionalTokens.js";
import "./handlers/NegRiskAdapter.js";
import "./handlers/FPMMFactory.js";
import "./handlers/FixedProductMarketMaker.js";

const {
  MockDb,
  FeeModule,
  UmaSportsOracle,
  RelayHub,
  SafeProxyFactory,
  USDC,
  Exchange,
  ConditionalTokens,
  NegRiskAdapter,
  FPMMFactory,
  FixedProductMarketMaker: FPMMTestHelper,
  Addresses,
} = TestHelpers;

// ============================================================
// Fee Module Tests
// ============================================================

describe("FeeModule", () => {
  it("should create a FeeRefunded entity from FeeRefunded event", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = FeeModule.FeeRefunded.createMockEvent({
      orderHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      to: Addresses.mockAddresses[0]!,
      id: 12345n,
      refund: 1000n,
      feeCharged: 500n,
    });

    const result = await FeeModule.FeeRefunded.processEvent({
      event: mockEvent,
      mockDb,
    });

    const entities = result.entities.FeeRefunded.getAll();
    expect(entities.length).toBe(1);
    const entity = entities[0]!;
    expect(entity.tokenId).toBe("12345");
    expect(entity.feeRefunded).toBe(1000n);
    expect(entity.feeCharged).toBe(500n);
    expect(entity.refundee).toBe(Addresses.mockAddresses[0]!);
  });
});

// ============================================================
// Sports Oracle Tests
// ============================================================

describe("UmaSportsOracle", () => {
  it("should create a Game entity from GameCreated event", async () => {
    const mockDb = MockDb.createMockDb();

    const gameId = "0x000000000000000000000000000000000000000000000000000000000000abcd";
    const mockEvent = UmaSportsOracle.GameCreated.createMockEvent({
      gameId,
      ordering: 0n,
      ancillaryData: "0x1234",
      timestamp: 1700000000n,
    });

    const result = await UmaSportsOracle.GameCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const entities = result.entities.Game.getAll();
    expect(entities.length).toBe(1);
    const game = entities[0]!;
    expect(game.state).toBe("Created");
    expect(game.ordering).toBe("home");
    expect(game.homeScore).toBe(0n);
    expect(game.awayScore).toBe(0n);
  });

  it("should update Game state on GameSettled", async () => {
    const mockDb = MockDb.createMockDb();
    const gameId = "0x000000000000000000000000000000000000000000000000000000000000abcd";

    const initialGame: Game = {
      id: gameId,
      ancillaryData: "0x1234",
      ordering: "home",
      state: "Created",
      homeScore: 0n,
      awayScore: 0n,
    };
    const seededDb = mockDb.entities.Game.set(initialGame);

    const mockEvent = UmaSportsOracle.GameSettled.createMockEvent({
      gameId,
      home: 3n,
      away: 1n,
    });

    const result = await UmaSportsOracle.GameSettled.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const game = result.entities.Game.get(gameId);
    expect(game).toBeDefined();
    expect(game!.state).toBe("Settled");
    expect(game!.homeScore).toBe(3n);
    expect(game!.awayScore).toBe(1n);
  });

  it("should create a Market entity from MarketCreated event", async () => {
    const mockDb = MockDb.createMockDb();

    const marketId = "0x0000000000000000000000000000000000000000000000000000000000001111";
    const gameId = "0x000000000000000000000000000000000000000000000000000000000000abcd";
    const conditionId = "0x0000000000000000000000000000000000000000000000000000000000002222";

    const mockEvent = UmaSportsOracle.MarketCreated.createMockEvent({
      marketId,
      gameId,
      conditionId,
      marketType: 0n,
      underdog: 1n,
      line: 150n,
    });

    const result = await UmaSportsOracle.MarketCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const entities = result.entities.Market.getAll();
    expect(entities.length).toBe(1);
    const market = entities[0]!;
    expect(market.state).toBe("Created");
    expect(market.marketType).toBe("moneyline");
    expect(market.underdog).toBe("away");
    expect(market.line).toBe(150n);
    expect(market.payouts).toEqual([]);
  });

  it("should update Market state on MarketResolved with payouts", async () => {
    const mockDb = MockDb.createMockDb();
    const marketId = "0x0000000000000000000000000000000000000000000000000000000000001111";

    const seededDb = mockDb.entities.Market.set({
      id: marketId,
      gameId: "0x000000000000000000000000000000000000000000000000000000000000abcd",
      state: "Created",
      marketType: "moneyline",
      underdog: "away",
      line: 150n,
      payouts: [] as bigint[],
    });

    const mockEvent = UmaSportsOracle.MarketResolved.createMockEvent({
      marketId,
      payouts: [1n, 0n],
    });

    const result = await UmaSportsOracle.MarketResolved.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const market = result.entities.Market.get(marketId);
    expect(market).toBeDefined();
    expect(market!.state).toBe("Resolved");
    expect(market!.payouts).toEqual([1n, 0n]);
  });
});

// ============================================================
// Wallet Tests (Phase 2A)
// ============================================================

describe("Wallet - SafeProxyFactory", () => {
  it("should create a Wallet entity from ProxyCreation event", async () => {
    const mockDb = MockDb.createMockDb();
    const proxyAddr = Addresses.mockAddresses[0]!;
    const ownerAddr = Addresses.mockAddresses[1]!;

    const mockEvent = SafeProxyFactory.ProxyCreation.createMockEvent({
      proxy: proxyAddr,
      owner: ownerAddr,
    });

    const result = await SafeProxyFactory.ProxyCreation.processEvent({
      event: mockEvent,
      mockDb,
    });

    const wallet = result.entities.Wallet.get(proxyAddr);
    expect(wallet).toBeDefined();
    expect(wallet!.signer).toBe(ownerAddr);
    expect(wallet!.type).toBe("safe");
    expect(wallet!.balance).toBe(0n);
  });
});

describe("Wallet - USDC Transfer", () => {
  it("should update wallet balance on incoming USDC transfer", async () => {
    const mockDb = MockDb.createMockDb();
    const walletAddr = Addresses.mockAddresses[0]!;
    const senderAddr = Addresses.mockAddresses[1]!;

    // Seed a wallet
    const seededDb = mockDb.entities.Wallet.set({
      id: walletAddr,
      signer: walletAddr,
      type: "safe",
      balance: 1000n,
      lastTransfer: 0n,
      createdAt: 100n,
    });

    const mockEvent = USDC.Transfer.createMockEvent({
      from: senderAddr,
      to: walletAddr,
      amount: 500n,
    });

    const result = await USDC.Transfer.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const wallet = result.entities.Wallet.get(walletAddr);
    expect(wallet).toBeDefined();
    expect(wallet!.balance).toBe(1500n);
  });

  it("should update wallet balance on outgoing USDC transfer", async () => {
    const mockDb = MockDb.createMockDb();
    const walletAddr = Addresses.mockAddresses[0]!;
    const receiverAddr = Addresses.mockAddresses[1]!;

    const seededDb = mockDb.entities.Wallet.set({
      id: walletAddr,
      signer: walletAddr,
      type: "safe",
      balance: 1000n,
      lastTransfer: 0n,
      createdAt: 100n,
    });

    const mockEvent = USDC.Transfer.createMockEvent({
      from: walletAddr,
      to: receiverAddr,
      amount: 300n,
    });

    const result = await USDC.Transfer.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const wallet = result.entities.Wallet.get(walletAddr);
    expect(wallet).toBeDefined();
    expect(wallet!.balance).toBe(700n);
  });
});

// ============================================================
// Exchange Tests (Phase 2B)
// ============================================================

describe("Exchange - OrderFilled", () => {
  it("should create an OrderFilledEvent and update Orderbook for a buy", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Exchange.OrderFilled.createMockEvent({
      orderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 0n, // Buy side
      takerAssetId: 42n,
      makerAmountFilled: 1_000_000n,
      takerAmountFilled: 500_000n,
      fee: 10_000n,
    });

    const result = await Exchange.OrderFilled.processEvent({
      event: mockEvent,
      mockDb,
    });

    // Check OrderFilledEvent was created
    const events = result.entities.OrderFilledEvent.getAll();
    expect(events.length).toBe(1);
    expect(events[0]!.makerAmountFilled).toBe(1_000_000n);

    // Check Orderbook was created/updated
    const orderbook = result.entities.Orderbook.get("42");
    expect(orderbook).toBeDefined();
    expect(orderbook!.tradesQuantity).toBe(1n);
    expect(orderbook!.buysQuantity).toBe(1n);
    expect(orderbook!.sellsQuantity).toBe(0n);
    expect(orderbook!.collateralVolume).toBe(1_000_000n);
    expect(orderbook!.collateralBuyVolume).toBe(1_000_000n);
  });

  it("should update Orderbook for a sell", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Exchange.OrderFilled.createMockEvent({
      orderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 42n, // Sell side (non-zero)
      takerAssetId: 0n,
      makerAmountFilled: 500_000n,
      takerAmountFilled: 1_000_000n,
      fee: 10_000n,
    });

    const result = await Exchange.OrderFilled.processEvent({
      event: mockEvent,
      mockDb,
    });

    const orderbook = result.entities.Orderbook.get("42");
    expect(orderbook).toBeDefined();
    expect(orderbook!.sellsQuantity).toBe(1n);
    expect(orderbook!.buysQuantity).toBe(0n);
    expect(orderbook!.collateralSellVolume).toBe(1_000_000n);
  });
});

describe("Exchange - OrdersMatched", () => {
  it("should create OrdersMatchedEvent and update global volume", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Exchange.OrdersMatched.createMockEvent({
      takerOrderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      takerOrderMaker: Addresses.mockAddresses[0]!,
      makerAssetId: 0n,
      takerAssetId: 42n,
      makerAmountFilled: 1_000_000n,
      takerAmountFilled: 500_000n,
    });

    const result = await Exchange.OrdersMatched.processEvent({
      event: mockEvent,
      mockDb,
    });

    const events = result.entities.OrdersMatchedEvent.getAll();
    expect(events.length).toBe(1);

    const global = result.entities.OrdersMatchedGlobal.get("");
    expect(global).toBeDefined();
    expect(global!.tradesQuantity).toBe(1n);
  });
});

describe("Exchange - TokenRegistered", () => {
  it("should create MarketData entities for both tokens", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Exchange.TokenRegistered.createMockEvent({
      token0: 100n,
      token1: 101n,
      conditionId: "0x0000000000000000000000000000000000000000000000000000000000003333",
    });

    const result = await Exchange.TokenRegistered.processEvent({
      event: mockEvent,
      mockDb,
    });

    const data0 = result.entities.MarketData.get("100");
    expect(data0).toBeDefined();
    expect(data0!.condition).toBe("0x0000000000000000000000000000000000000000000000000000000000003333");

    const data1 = result.entities.MarketData.get("101");
    expect(data1).toBeDefined();
    expect(data1!.condition).toBe("0x0000000000000000000000000000000000000000000000000000000000003333");
  });
});

// ============================================================
// Phase 3: ConditionalTokens Tests
// ============================================================

const MOCK_CONDITION_ID =
  "0x000000000000000000000000000000000000000000000000000000000000abcd";
const MOCK_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const MOCK_CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const MOCK_PARENT_COLLECTION =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("ConditionalTokens - ConditionPreparation", () => {
  it("should create Condition and Position entities for binary condition", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ConditionalTokens.ConditionPreparation.createMockEvent({
      conditionId: MOCK_CONDITION_ID,
      oracle: Addresses.mockAddresses[0]!,
      questionId:
        "0x0000000000000000000000000000000000000000000000000000000000001111",
      outcomeSlotCount: 2n,
    });

    const result = await ConditionalTokens.ConditionPreparation.processEvent({
      event: mockEvent,
      mockDb,
    });

    const condition = result.entities.Condition.get(MOCK_CONDITION_ID);
    expect(condition).toBeDefined();

    // Should create 2 Position entities
    const positions = result.entities.Position.getAll();
    expect(positions.length).toBe(2);
  });

  it("should skip conditions with more than 2 outcomes", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = ConditionalTokens.ConditionPreparation.createMockEvent({
      conditionId: MOCK_CONDITION_ID,
      oracle: Addresses.mockAddresses[0]!,
      questionId:
        "0x0000000000000000000000000000000000000000000000000000000000001111",
      outcomeSlotCount: 3n,
    });

    const result = await ConditionalTokens.ConditionPreparation.processEvent({
      event: mockEvent,
      mockDb,
    });

    const condition = result.entities.Condition.get(MOCK_CONDITION_ID);
    expect(condition).toBeUndefined();
  });
});

describe("ConditionalTokens - PositionSplit", () => {
  it("should create Split entity and update OI for USDC split", async () => {
    const mockDb = MockDb.createMockDb();
    const seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID, positionIds: [100n, 101n], payoutNumerators: [], payoutDenominator: 0n });

    const mockEvent = ConditionalTokens.PositionSplit.createMockEvent({
      stakeholder: Addresses.mockAddresses[0]!,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 1_000_000n,
    });

    const result = await ConditionalTokens.PositionSplit.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // Check Split was created
    const splits = result.entities.Split.getAll();
    expect(splits.length).toBe(1);
    expect(splits[0]!.amount).toBe(1_000_000n);

    // Check OI was updated
    const marketOI = result.entities.MarketOpenInterest.get(MOCK_CONDITION_ID);
    expect(marketOI).toBeDefined();
    expect(marketOI!.amount).toBe(1_000_000n);

    const globalOI = result.entities.GlobalOpenInterest.get("");
    expect(globalOI).toBeDefined();
    expect(globalOI!.amount).toBe(1_000_000n);
  });

  it("should skip Split for NegRiskAdapter stakeholder but still update OI", async () => {
    const mockDb = MockDb.createMockDb();
    const NEG_RISK_ADAPTER_ADDR = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
    const seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID, positionIds: [100n, 101n], payoutNumerators: [], payoutDenominator: 0n });

    const mockEvent = ConditionalTokens.PositionSplit.createMockEvent({
      stakeholder: NEG_RISK_ADAPTER_ADDR,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 500_000n,
    });

    const result = await ConditionalTokens.PositionSplit.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // No Split entity (NegRiskAdapter is in skip list)
    const splits = result.entities.Split.getAll();
    expect(splits.length).toBe(0);

    // OI should still be updated (USDC collateral)
    const globalOI = result.entities.GlobalOpenInterest.get("");
    expect(globalOI).toBeDefined();
    expect(globalOI!.amount).toBe(500_000n);
  });
});

describe("ConditionalTokens - PositionsMerge", () => {
  it("should create Merge entity and decrease OI", async () => {
    const mockDb = MockDb.createMockDb();
    let seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID, positionIds: [100n, 101n], payoutNumerators: [], payoutDenominator: 0n });
    seededDb = seededDb.entities.MarketOpenInterest.set({
      id: MOCK_CONDITION_ID,
      amount: 2_000_000n,
    });
    seededDb = seededDb.entities.GlobalOpenInterest.set({
      id: "",
      amount: 2_000_000n,
    });

    const mockEvent = ConditionalTokens.PositionsMerge.createMockEvent({
      stakeholder: Addresses.mockAddresses[0]!,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 500_000n,
    });

    const result = await ConditionalTokens.PositionsMerge.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const merges = result.entities.Merge.getAll();
    expect(merges.length).toBe(1);

    const marketOI = result.entities.MarketOpenInterest.get(MOCK_CONDITION_ID);
    expect(marketOI!.amount).toBe(1_500_000n);

    const globalOI = result.entities.GlobalOpenInterest.get("");
    expect(globalOI!.amount).toBe(1_500_000n);
  });
});

describe("ConditionalTokens - PayoutRedemption", () => {
  it("should create Redemption entity and decrease OI", async () => {
    const mockDb = MockDb.createMockDb();
    let seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID, positionIds: [100n, 101n], payoutNumerators: [], payoutDenominator: 0n });
    seededDb = seededDb.entities.MarketOpenInterest.set({
      id: MOCK_CONDITION_ID,
      amount: 1_000_000n,
    });
    seededDb = seededDb.entities.GlobalOpenInterest.set({
      id: "",
      amount: 1_000_000n,
    });

    const mockEvent = ConditionalTokens.PayoutRedemption.createMockEvent({
      redeemer: Addresses.mockAddresses[0]!,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      indexSets: [1n, 2n],
      payout: 1_000_000n,
    });

    const result = await ConditionalTokens.PayoutRedemption.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const redemptions = result.entities.Redemption.getAll();
    expect(redemptions.length).toBe(1);
    expect(redemptions[0]!.payout).toBe(1_000_000n);

    const marketOI = result.entities.MarketOpenInterest.get(MOCK_CONDITION_ID);
    expect(marketOI!.amount).toBe(0n);
  });
});

// ============================================================
// Phase 3: NegRiskAdapter Tests
// ============================================================

describe("NegRiskAdapter - MarketPrepared", () => {
  it("should create NegRiskEvent entity", async () => {
    const mockDb = MockDb.createMockDb();
    const marketId =
      "0x0000000000000000000000000000000000000000000000000000000000005555";

    const mockEvent = NegRiskAdapter.MarketPrepared.createMockEvent({
      marketId,
      oracle: Addresses.mockAddresses[0]!,
      feeBips: 100n,
      data: "0x",
    });

    const result = await NegRiskAdapter.MarketPrepared.processEvent({
      event: mockEvent,
      mockDb,
    });

    const negRiskEvent = result.entities.NegRiskEvent.get(marketId);
    expect(negRiskEvent).toBeDefined();
    expect(negRiskEvent!.feeBps).toBe(100n);
    expect(negRiskEvent!.questionCount).toBe(0n);
  });
});

describe("NegRiskAdapter - QuestionPrepared", () => {
  it("should increment questionCount", async () => {
    const mockDb = MockDb.createMockDb();
    const marketId =
      "0x0000000000000000000000000000000000000000000000000000000000005555";

    const seededDb = mockDb.entities.NegRiskEvent.set({
      id: marketId,
      feeBps: 100n,
      questionCount: 0n,
    });

    const mockEvent = NegRiskAdapter.QuestionPrepared.createMockEvent({
      marketId,
      questionId:
        "0x0000000000000000000000000000000000000000000000000000000000006666",
      index: 0n,
      data: "0x",
    });

    const result = await NegRiskAdapter.QuestionPrepared.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const negRiskEvent = result.entities.NegRiskEvent.get(marketId);
    expect(negRiskEvent!.questionCount).toBe(1n);
  });
});

describe("NegRiskAdapter - PositionSplit", () => {
  it("should create Split and update OI", async () => {
    const mockDb = MockDb.createMockDb();
    const seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID, positionIds: [100n, 101n], payoutNumerators: [], payoutDenominator: 0n });

    const mockEvent = NegRiskAdapter.PositionSplit.createMockEvent({
      stakeholder: Addresses.mockAddresses[0]!,
      conditionId: MOCK_CONDITION_ID,
      amount: 1_000_000n,
    });

    const result = await NegRiskAdapter.PositionSplit.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const splits = result.entities.Split.getAll();
    expect(splits.length).toBe(1);

    const marketOI = result.entities.MarketOpenInterest.get(MOCK_CONDITION_ID);
    expect(marketOI!.amount).toBe(1_000_000n);
  });
});

describe("NegRiskAdapter - PositionsConverted", () => {
  it("should create NegRiskConversion entity", async () => {
    const mockDb = MockDb.createMockDb();
    const marketId =
      "0x0000000000000000000000000000000000000000000000000000000000005555";

    const seededDb = mockDb.entities.NegRiskEvent.set({
      id: marketId,
      feeBps: 0n,
      questionCount: 3n,
    });

    const mockEvent = NegRiskAdapter.PositionsConverted.createMockEvent({
      stakeholder: Addresses.mockAddresses[0]!,
      marketId,
      indexSet: 7n, // binary 111 = all 3 questions
      amount: 1_000_000n,
    });

    const result = await NegRiskAdapter.PositionsConverted.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const conversions = result.entities.NegRiskConversion.getAll();
    expect(conversions.length).toBe(1);
    expect(conversions[0]!.amount).toBe(1_000_000n);
    expect(conversions[0]!.questionCount).toBe(3n);
  });
});

// ============================================================
// Phase 3: FPMMFactory Tests
// ============================================================

describe("FPMMFactory - FixedProductMarketMakerCreation", () => {
  it("should create FixedProductMarketMaker entity with full fields", async () => {
    const mockDb = MockDb.createMockDb();
    const fpmmAddr = Addresses.mockAddresses[0]!;

    // Seed condition (required for factory validation)
    const seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent =
      FPMMFactory.FixedProductMarketMakerCreation.createMockEvent({
        creator: Addresses.mockAddresses[1]!,
        fixedProductMarketMaker: fpmmAddr,
        conditionalTokens: MOCK_CONDITIONAL_TOKENS,
        collateralToken: MOCK_USDC,
        conditionIds: [MOCK_CONDITION_ID],
        fee: 2000n,
      });

    const result =
      await FPMMFactory.FixedProductMarketMakerCreation.processEvent({
        event: mockEvent,
        mockDb: seededDb,
      });

    const fpmm = result.entities.FixedProductMarketMaker.get(fpmmAddr);
    expect(fpmm).toBeDefined();
    expect(fpmm!.id).toBe(fpmmAddr);
    expect(fpmm!.fee).toBe(2000n);
    expect(fpmm!.tradesQuantity).toBe(0n);
    expect(fpmm!.totalSupply).toBe(0n);
    expect(fpmm!.outcomeTokenAmounts).toEqual([0n, 0n]);
    expect(fpmm!.conditions).toEqual([MOCK_CONDITION_ID]);
  });

  it("should skip FPMM with wrong ConditionalTokens address", async () => {
    const mockDb = MockDb.createMockDb();
    const fpmmAddr = Addresses.mockAddresses[0]!;

    const seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent =
      FPMMFactory.FixedProductMarketMakerCreation.createMockEvent({
        creator: Addresses.mockAddresses[1]!,
        fixedProductMarketMaker: fpmmAddr,
        conditionalTokens: Addresses.mockAddresses[2]!, // wrong address
        collateralToken: MOCK_USDC,
        conditionIds: [MOCK_CONDITION_ID],
        fee: 2000n,
      });

    const result =
      await FPMMFactory.FixedProductMarketMakerCreation.processEvent({
        event: mockEvent,
        mockDb: seededDb,
      });

    const fpmm = result.entities.FixedProductMarketMaker.get(fpmmAddr);
    expect(fpmm).toBeUndefined();
  });
});

// ============================================================
// Phase 4: PnL Tests
// ============================================================

describe("PnL - Exchange OrderFilled", () => {
  it("should create UserPosition on buy order fill", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Exchange.OrderFilled.createMockEvent({
      orderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 0n, // Buy: maker sends USDC
      takerAssetId: 42n, // Buy: taker sends tokens
      makerAmountFilled: 500_000n, // 0.5 USDC
      takerAmountFilled: 1_000_000n, // 1 token
      fee: 10_000n,
    });

    const result = await Exchange.OrderFilled.processEvent({
      event: mockEvent,
      mockDb,
    });

    // UserPosition should be created for the buyer
    const positions = result.entities.UserPosition.getAll();
    expect(positions.length).toBe(1);
    const pos = positions[0]!;
    expect(pos.user).toBe(Addresses.mockAddresses[0]!);
    expect(pos.tokenId).toBe(42n);
    expect(pos.amount).toBe(1_000_000n);
    // Price = 500_000 * 1_000_000 / 1_000_000 = 500_000 (0.5 USDC)
    expect(pos.avgPrice).toBe(500_000n);
    expect(pos.realizedPnl).toBe(0n);
  });
});

describe("PnL - ConditionalTokens ConditionResolution", () => {
  it("should store payout numerators on Condition", async () => {
    const mockDb = MockDb.createMockDb();
    const seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent = ConditionalTokens.ConditionResolution.createMockEvent({
      conditionId: MOCK_CONDITION_ID,
      oracle: Addresses.mockAddresses[0]!,
      questionId: "0x0000000000000000000000000000000000000000000000000000000000001111",
      outcomeSlotCount: 2n,
      payoutNumerators: [1n, 0n],
    });

    const result = await ConditionalTokens.ConditionResolution.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const condition = result.entities.Condition.get(MOCK_CONDITION_ID);
    expect(condition).toBeDefined();
    expect(condition!.payoutNumerators).toEqual([1n, 0n]);
    expect(condition!.payoutDenominator).toBe(1n);
  });
});

describe("PnL - UserPosition averaging", () => {
  it("should compute weighted average price across multiple buys", async () => {
    const mockDb = MockDb.createMockDb();

    // First buy: 1 token at 0.5
    const event1 = Exchange.OrderFilled.createMockEvent({
      orderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 0n,
      takerAssetId: 42n,
      makerAmountFilled: 500_000n,
      takerAmountFilled: 1_000_000n,
      fee: 0n,
    });

    const result1 = await Exchange.OrderFilled.processEvent({
      event: event1,
      mockDb,
    });

    // Second buy: 1 token at 0.8
    const event2 = Exchange.OrderFilled.createMockEvent({
      orderHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 0n,
      takerAssetId: 42n,
      makerAmountFilled: 800_000n,
      takerAmountFilled: 1_000_000n,
      fee: 0n,
    });

    const result2 = await Exchange.OrderFilled.processEvent({
      event: event2,
      mockDb: result1,
    });

    const pos = result2.entities.UserPosition.get(
      `${Addresses.mockAddresses[0]!}-42`,
    );
    expect(pos).toBeDefined();
    expect(pos!.amount).toBe(2_000_000n);
    // avgPrice = (500_000 * 1_000_000 + 800_000 * 1_000_000) / 2_000_000 = 650_000
    expect(pos!.avgPrice).toBe(650_000n);
    expect(pos!.totalBought).toBe(2_000_000n);
  });

  it("should compute realized PnL on sell", async () => {
    const mockDb = MockDb.createMockDb();

    // Seed position: 2 tokens at avg price 0.5
    const seededDb = mockDb.entities.UserPosition.set({
      id: `${Addresses.mockAddresses[0]!}-42`,
      user: Addresses.mockAddresses[0]!,
      tokenId: 42n,
      amount: 2_000_000n,
      avgPrice: 500_000n,
      realizedPnl: 0n,
      totalBought: 2_000_000n,
    });

    // Sell: 1 token at 0.8
    const event = Exchange.OrderFilled.createMockEvent({
      orderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 42n, // Sell: maker sends tokens
      takerAssetId: 0n,
      makerAmountFilled: 1_000_000n,
      takerAmountFilled: 800_000n,
      fee: 0n,
    });

    const result = await Exchange.OrderFilled.processEvent({
      event,
      mockDb: seededDb,
    });

    const pos = result.entities.UserPosition.get(
      `${Addresses.mockAddresses[0]!}-42`,
    );
    expect(pos).toBeDefined();
    expect(pos!.amount).toBe(1_000_000n); // 2 - 1 = 1
    // realizedPnl = 1_000_000 * (800_000 - 500_000) / 1_000_000 = 300_000
    expect(pos!.realizedPnl).toBe(300_000n);
  });
});

// ============================================================
// Bug Fix Verification Tests
// ============================================================

describe("Bug Fix: NEG_RISK_EXCHANGE should be skipped for PnL in ConditionalTokens", () => {
  it("should NOT create UserPosition for NegRiskExchange on PositionSplit", async () => {
    const mockDb = MockDb.createMockDb();
    const NEG_RISK_EXCHANGE_ADDR = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
    const seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent = ConditionalTokens.PositionSplit.createMockEvent({
      stakeholder: NEG_RISK_EXCHANGE_ADDR,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 1_000_000n,
    });

    const result = await ConditionalTokens.PositionSplit.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // No Split entity (NegRiskExchange is in SKIP_ACTIVITY)
    const splits = result.entities.Split.getAll();
    expect(splits.length).toBe(0);

    // No UserPosition (NegRiskExchange should be in SKIP_PNL)
    const positions = result.entities.UserPosition.getAll();
    expect(positions.length).toBe(0);

    // OI should still be updated (USDC collateral)
    const globalOI = result.entities.GlobalOpenInterest.get("");
    expect(globalOI).toBeDefined();
    expect(globalOI!.amount).toBe(1_000_000n);
  });

  it("should NOT create UserPosition for NegRiskExchange on PositionsMerge", async () => {
    const mockDb = MockDb.createMockDb();
    const NEG_RISK_EXCHANGE_ADDR = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
    let seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });
    seededDb = seededDb.entities.MarketOpenInterest.set({
      id: MOCK_CONDITION_ID,
      amount: 2_000_000n,
    });
    seededDb = seededDb.entities.GlobalOpenInterest.set({
      id: "",
      amount: 2_000_000n,
    });

    const mockEvent = ConditionalTokens.PositionsMerge.createMockEvent({
      stakeholder: NEG_RISK_EXCHANGE_ADDR,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 500_000n,
    });

    const result = await ConditionalTokens.PositionsMerge.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // No Merge entity (NegRiskExchange is in SKIP_ACTIVITY)
    const merges = result.entities.Merge.getAll();
    expect(merges.length).toBe(0);

    // No UserPosition (NegRiskExchange should be in SKIP_PNL)
    const positions = result.entities.UserPosition.getAll();
    expect(positions.length).toBe(0);

    // OI should still decrease
    const marketOI = result.entities.MarketOpenInterest.get(MOCK_CONDITION_ID);
    expect(marketOI!.amount).toBe(1_500_000n);
  });
});

describe("Bug Fix: Entity IDs should use logIndex to prevent collisions", () => {
  it("OrderFilledEvent ID should include logIndex", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Exchange.OrderFilled.createMockEvent({
      orderHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      makerAssetId: 0n,
      takerAssetId: 42n,
      makerAmountFilled: 500_000n,
      takerAmountFilled: 1_000_000n,
      fee: 0n,
    });

    const result = await Exchange.OrderFilled.processEvent({
      event: mockEvent,
      mockDb,
    });

    const events = result.entities.OrderFilledEvent.getAll();
    expect(events.length).toBe(1);
    // ID should contain logIndex (not orderHash)
    const eventId = events[0]!.id;
    expect(eventId).toContain("_");
    // Should NOT contain the orderHash as part of the ID
    expect(eventId).not.toContain("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
  });
});

// ============================================================
// Additional Coverage: FPMM Buy/Sell Tests
// ============================================================

describe("FPMM - Buy", () => {
  it("should update FPMM metrics and create transaction on buy", async () => {
    const mockDb = MockDb.createMockDb();
    const fpmmAddr = Addresses.mockAddresses[0]!;

    let seededDb = mockDb.entities.FixedProductMarketMaker.set({
      id: fpmmAddr,
      creator: Addresses.mockAddresses[1]!,
      creationTimestamp: 100n,
      creationTransactionHash: "0x1111",
      collateralToken: MOCK_USDC,
      conditionalTokenAddress: MOCK_CONDITIONAL_TOKENS.toLowerCase(),
      conditions: [MOCK_CONDITION_ID],
      fee: 2000n,
      outcomeSlotCount: 2n,
      totalSupply: 10_000_000n,
      outcomeTokenAmounts: [5_000_000n, 5_000_000n],
      outcomeTokenPrices: [new BigNumber(0.5), new BigNumber(0.5)],
      lastActiveDay: 0n,
      collateralVolume: 0n,
      scaledCollateralVolume: new BigNumber(0),
      collateralBuyVolume: 0n,
      scaledCollateralBuyVolume: new BigNumber(0),
      collateralSellVolume: 0n,
      scaledCollateralSellVolume: new BigNumber(0),
      liquidityParameter: 5_000_000n,
      scaledLiquidityParameter: new BigNumber(5),
      feeVolume: 0n,
      scaledFeeVolume: new BigNumber(0),
      tradesQuantity: 0n,
      buysQuantity: 0n,
      sellsQuantity: 0n,
      liquidityAddQuantity: 0n,
      liquidityRemoveQuantity: 0n,
    });
    seededDb = seededDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent = FPMMTestHelper.FPMMBuy.createMockEvent({
      buyer: Addresses.mockAddresses[2]!,
      investmentAmount: 1_000_000n,
      feeAmount: 20_000n,
      outcomeIndex: 0n,
      outcomeTokensBought: 1_500_000n,
    });
    // Override srcAddress to match the FPMM
    (mockEvent as any).srcAddress = fpmmAddr;

    const result = await FPMMTestHelper.FPMMBuy.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const fpmm = result.entities.FixedProductMarketMaker.get(fpmmAddr);
    expect(fpmm).toBeDefined();
    expect(fpmm!.tradesQuantity).toBe(1n);
    expect(fpmm!.buysQuantity).toBe(1n);
    expect(fpmm!.collateralVolume).toBe(1_000_000n);
    expect(fpmm!.feeVolume).toBe(20_000n);

    // Check transaction was recorded
    const txns = result.entities.FpmmTransaction.getAll();
    expect(txns.length).toBe(1);
    expect(txns[0]!.type).toBe("Buy");
    expect(txns[0]!.tradeAmount).toBe(1_000_000n);
  });
});

describe("FPMM - Sell", () => {
  it("should update FPMM metrics and create transaction on sell", async () => {
    const mockDb = MockDb.createMockDb();
    const fpmmAddr = Addresses.mockAddresses[0]!;

    let seededDb = mockDb.entities.FixedProductMarketMaker.set({
      id: fpmmAddr,
      creator: Addresses.mockAddresses[1]!,
      creationTimestamp: 100n,
      creationTransactionHash: "0x1111",
      collateralToken: MOCK_USDC,
      conditionalTokenAddress: MOCK_CONDITIONAL_TOKENS.toLowerCase(),
      conditions: [MOCK_CONDITION_ID],
      fee: 2000n,
      outcomeSlotCount: 2n,
      totalSupply: 10_000_000n,
      outcomeTokenAmounts: [4_000_000n, 6_000_000n],
      outcomeTokenPrices: [new BigNumber(0.6), new BigNumber(0.4)],
      lastActiveDay: 0n,
      collateralVolume: 0n,
      scaledCollateralVolume: new BigNumber(0),
      collateralBuyVolume: 0n,
      scaledCollateralBuyVolume: new BigNumber(0),
      collateralSellVolume: 0n,
      scaledCollateralSellVolume: new BigNumber(0),
      liquidityParameter: 4_898_979n,
      scaledLiquidityParameter: new BigNumber(4.898979),
      feeVolume: 0n,
      scaledFeeVolume: new BigNumber(0),
      tradesQuantity: 0n,
      buysQuantity: 0n,
      sellsQuantity: 0n,
      liquidityAddQuantity: 0n,
      liquidityRemoveQuantity: 0n,
    });
    seededDb = seededDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent = FPMMTestHelper.FPMMSell.createMockEvent({
      seller: Addresses.mockAddresses[2]!,
      returnAmount: 500_000n,
      feeAmount: 10_000n,
      outcomeIndex: 0n,
      outcomeTokensSold: 800_000n,
    });
    (mockEvent as any).srcAddress = fpmmAddr;

    const result = await FPMMTestHelper.FPMMSell.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const fpmm = result.entities.FixedProductMarketMaker.get(fpmmAddr);
    expect(fpmm).toBeDefined();
    expect(fpmm!.tradesQuantity).toBe(1n);
    expect(fpmm!.sellsQuantity).toBe(1n);
    expect(fpmm!.collateralVolume).toBe(500_000n);
    expect(fpmm!.collateralSellVolume).toBe(500_000n);
    expect(fpmm!.feeVolume).toBe(10_000n);

    const txns = result.entities.FpmmTransaction.getAll();
    expect(txns.length).toBe(1);
    expect(txns[0]!.type).toBe("Sell");
  });
});

// ============================================================
// Additional Coverage: PnL edge cases
// ============================================================

describe("PnL - Split creates positions at 50 cents", () => {
  it("should create UserPositions for both outcomes at FIFTY_CENTS on split", async () => {
    const mockDb = MockDb.createMockDb();
    const user = Addresses.mockAddresses[0]!;
    const seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });

    const mockEvent = ConditionalTokens.PositionSplit.createMockEvent({
      stakeholder: user,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 2_000_000n,
    });

    const result = await ConditionalTokens.PositionSplit.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // Should create 2 UserPositions (one for each outcome)
    const positions = result.entities.UserPosition.getAll();
    expect(positions.length).toBe(2);

    const pos0 = result.entities.UserPosition.get(`${user}-100`);
    expect(pos0).toBeDefined();
    expect(pos0!.amount).toBe(2_000_000n);
    expect(pos0!.avgPrice).toBe(500_000n); // FIFTY_CENTS

    const pos1 = result.entities.UserPosition.get(`${user}-101`);
    expect(pos1).toBeDefined();
    expect(pos1!.amount).toBe(2_000_000n);
    expect(pos1!.avgPrice).toBe(500_000n); // FIFTY_CENTS
  });
});

describe("PnL - Merge sells positions at 50 cents", () => {
  it("should decrease UserPosition amounts and realize PnL on merge", async () => {
    const mockDb = MockDb.createMockDb();
    const user = Addresses.mockAddresses[0]!;
    let seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [],
      payoutDenominator: 0n,
    });
    // Seed user positions bought at 0.6 and 0.4
    seededDb = seededDb.entities.UserPosition.set({
      id: `${user}-100`,
      user,
      tokenId: 100n,
      amount: 2_000_000n,
      avgPrice: 600_000n,
      realizedPnl: 0n,
      totalBought: 2_000_000n,
    });
    seededDb = seededDb.entities.UserPosition.set({
      id: `${user}-101`,
      user,
      tokenId: 101n,
      amount: 2_000_000n,
      avgPrice: 400_000n,
      realizedPnl: 0n,
      totalBought: 2_000_000n,
    });

    const mockEvent = ConditionalTokens.PositionsMerge.createMockEvent({
      stakeholder: user,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      partition: [1n, 2n],
      amount: 1_000_000n,
    });

    const result = await ConditionalTokens.PositionsMerge.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const pos0 = result.entities.UserPosition.get(`${user}-100`);
    expect(pos0).toBeDefined();
    expect(pos0!.amount).toBe(1_000_000n);
    // PnL for outcome 0: 1_000_000 * (500_000 - 600_000) / 1_000_000 = -100_000
    expect(pos0!.realizedPnl).toBe(-100_000n);

    const pos1 = result.entities.UserPosition.get(`${user}-101`);
    expect(pos1).toBeDefined();
    expect(pos1!.amount).toBe(1_000_000n);
    // PnL for outcome 1: 1_000_000 * (500_000 - 400_000) / 1_000_000 = 100_000
    expect(pos1!.realizedPnl).toBe(100_000n);
  });
});

describe("PnL - PayoutRedemption sells at payout price", () => {
  it("should realize PnL based on condition payouts", async () => {
    const mockDb = MockDb.createMockDb();
    const user = Addresses.mockAddresses[0]!;
    // Condition resolved: outcome 0 won (payout [1, 0])
    let seededDb = mockDb.entities.Condition.set({
      id: MOCK_CONDITION_ID,
      positionIds: [100n, 101n],
      payoutNumerators: [1n, 0n],
      payoutDenominator: 1n,
    });
    // User holds 1 token of each outcome bought at 0.5
    seededDb = seededDb.entities.UserPosition.set({
      id: `${user}-100`,
      user,
      tokenId: 100n,
      amount: 1_000_000n,
      avgPrice: 500_000n,
      realizedPnl: 0n,
      totalBought: 1_000_000n,
    });
    seededDb = seededDb.entities.UserPosition.set({
      id: `${user}-101`,
      user,
      tokenId: 101n,
      amount: 1_000_000n,
      avgPrice: 500_000n,
      realizedPnl: 0n,
      totalBought: 1_000_000n,
    });
    seededDb = seededDb.entities.MarketOpenInterest.set({
      id: MOCK_CONDITION_ID,
      amount: 1_000_000n,
    });
    seededDb = seededDb.entities.GlobalOpenInterest.set({
      id: "",
      amount: 1_000_000n,
    });

    const mockEvent = ConditionalTokens.PayoutRedemption.createMockEvent({
      redeemer: user,
      collateralToken: MOCK_USDC,
      parentCollectionId: MOCK_PARENT_COLLECTION,
      conditionId: MOCK_CONDITION_ID,
      indexSets: [1n, 2n],
      payout: 1_000_000n,
    });

    const result = await ConditionalTokens.PayoutRedemption.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // Outcome 0: sell at price 1.0 (payout = 1/1 * SCALE = 1_000_000)
    // PnL = 1_000_000 * (1_000_000 - 500_000) / 1_000_000 = 500_000
    const pos0 = result.entities.UserPosition.get(`${user}-100`);
    expect(pos0).toBeDefined();
    expect(pos0!.amount).toBe(0n);
    expect(pos0!.realizedPnl).toBe(500_000n);

    // Outcome 1: sell at price 0.0 (payout = 0/1 * SCALE = 0)
    // PnL = 1_000_000 * (0 - 500_000) / 1_000_000 = -500_000
    const pos1 = result.entities.UserPosition.get(`${user}-101`);
    expect(pos1).toBeDefined();
    expect(pos1!.amount).toBe(0n);
    expect(pos1!.realizedPnl).toBe(-500_000n);
  });
});

// ============================================================
// Additional Coverage: FPMM Transfer (pool membership)
// ============================================================

describe("FPMM - Transfer", () => {
  it("should update pool membership on LP share transfer", async () => {
    const mockDb = MockDb.createMockDb();
    const fpmmAddr = Addresses.mockAddresses[0]!;
    const from = Addresses.mockAddresses[1]!;
    const to = Addresses.mockAddresses[2]!;

    // Seed sender membership
    const seededDb = mockDb.entities.FpmmPoolMembership.set({
      id: `${fpmmAddr}-${from}`,
      pool_id: fpmmAddr,
      funder: from,
      amount: 5_000_000n,
    });

    const mockEvent = FPMMTestHelper.Transfer.createMockEvent({
      from,
      to,
      value: 2_000_000n,
    });
    (mockEvent as any).srcAddress = fpmmAddr;

    const result = await FPMMTestHelper.Transfer.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const fromMembership = result.entities.FpmmPoolMembership.get(`${fpmmAddr}-${from}`);
    expect(fromMembership).toBeDefined();
    expect(fromMembership!.amount).toBe(3_000_000n);

    const toMembership = result.entities.FpmmPoolMembership.get(`${fpmmAddr}-${to}`);
    expect(toMembership).toBeDefined();
    expect(toMembership!.amount).toBe(2_000_000n);
  });
});

// ============================================================
// Additional Coverage: Wallet GlobalUSDCBalance
// ============================================================

describe("Wallet - GlobalUSDCBalance tracking", () => {
  it("should create and update GlobalUSDCBalance on wallet receive", async () => {
    const mockDb = MockDb.createMockDb();
    const walletAddr = Addresses.mockAddresses[0]!;
    const senderAddr = Addresses.mockAddresses[1]!;

    const seededDb = mockDb.entities.Wallet.set({
      id: walletAddr,
      signer: walletAddr,
      type: "safe",
      balance: 0n,
      lastTransfer: 0n,
      createdAt: 100n,
    });

    const mockEvent = USDC.Transfer.createMockEvent({
      from: senderAddr,
      to: walletAddr,
      amount: 1_000_000n,
    });

    const result = await USDC.Transfer.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    const global = result.entities.GlobalUSDCBalance.get("global");
    expect(global).toBeDefined();
    expect(global!.balance).toBe(1_000_000n);
  });

  it("should net to zero for transfers between two wallets", async () => {
    const mockDb = MockDb.createMockDb();
    const wallet1 = Addresses.mockAddresses[0]!;
    const wallet2 = Addresses.mockAddresses[1]!;

    let seededDb = mockDb.entities.Wallet.set({
      id: wallet1,
      signer: wallet1,
      type: "safe",
      balance: 5_000_000n,
      lastTransfer: 0n,
      createdAt: 100n,
    });
    seededDb = seededDb.entities.Wallet.set({
      id: wallet2,
      signer: wallet2,
      type: "safe",
      balance: 0n,
      lastTransfer: 0n,
      createdAt: 100n,
    });
    seededDb = seededDb.entities.GlobalUSDCBalance.set({
      id: "global",
      balance: 5_000_000n,
    });

    const mockEvent = USDC.Transfer.createMockEvent({
      from: wallet1,
      to: wallet2,
      amount: 2_000_000n,
    });

    const result = await USDC.Transfer.processEvent({
      event: mockEvent,
      mockDb: seededDb,
    });

    // Global balance should remain the same
    const global = result.entities.GlobalUSDCBalance.get("global");
    expect(global).toBeDefined();
    expect(global!.balance).toBe(5_000_000n);

    // Individual balances should update
    expect(result.entities.Wallet.get(wallet1)!.balance).toBe(3_000_000n);
    expect(result.entities.Wallet.get(wallet2)!.balance).toBe(2_000_000n);
  });
});

// ============================================================
// Additional Coverage: Utility function tests
// ============================================================

describe("Utility - parseOrderFilled", () => {
  it("should parse buy order correctly", () => {
    const { parseOrderFilled } = require("./utils/pnl.js");
    const result = parseOrderFilled({
      makerAssetId: 0n,
      takerAssetId: 42n,
      makerAmountFilled: 500_000n,
      takerAmountFilled: 1_000_000n,
      maker: "0xuser1",
    });

    expect(result.side).toBe("BUY");
    expect(result.account).toBe("0xuser1");
    expect(result.baseAmount).toBe(1_000_000n);
    expect(result.quoteAmount).toBe(500_000n);
    expect(result.positionId).toBe(42n);
  });

  it("should parse sell order correctly", () => {
    const { parseOrderFilled } = require("./utils/pnl.js");
    const result = parseOrderFilled({
      makerAssetId: 42n,
      takerAssetId: 0n,
      makerAmountFilled: 1_000_000n,
      takerAmountFilled: 800_000n,
      maker: "0xuser1",
    });

    expect(result.side).toBe("SELL");
    expect(result.account).toBe("0xuser1");
    expect(result.baseAmount).toBe(1_000_000n);
    expect(result.quoteAmount).toBe(800_000n);
    expect(result.positionId).toBe(42n);
  });
});

describe("Utility - computeFpmmPrice", () => {
  it("should compute FPMM prices correctly", () => {
    const { computeFpmmPrice } = require("./utils/pnl.js");

    // Equal amounts → 50/50 price
    expect(computeFpmmPrice([1_000_000n, 1_000_000n], 0)).toBe(500_000n);
    expect(computeFpmmPrice([1_000_000n, 1_000_000n], 1)).toBe(500_000n);

    // Unequal amounts
    // price[0] = amounts[1] * SCALE / total = 3_000_000 * 1_000_000 / 4_000_000 = 750_000
    expect(computeFpmmPrice([1_000_000n, 3_000_000n], 0)).toBe(750_000n);
    // price[1] = amounts[0] * SCALE / total = 1_000_000 * 1_000_000 / 4_000_000 = 250_000
    expect(computeFpmmPrice([1_000_000n, 3_000_000n], 1)).toBe(250_000n);

    // Zero amounts
    expect(computeFpmmPrice([0n, 0n], 0)).toBe(0n);
  });
});

describe("Utility - computeNegRiskYesPrice", () => {
  it("should compute neg-risk YES price correctly", () => {
    const { computeNegRiskYesPrice } = require("./utils/pnl.js");

    // 2 NO at 0.9 each, 1 YES remaining, 3 questions total
    // yesPrice = (900_000 * 2 - 1_000_000 * 1) / 1 = 800_000
    const result = computeNegRiskYesPrice(900_000n, 2, 3);
    expect(result).toBe(800_000n);

    // All questions are NO (yesCount = 0) → 0
    expect(computeNegRiskYesPrice(500_000n, 3, 3)).toBe(0n);
  });
});

describe("Utility - indexSetContains", () => {
  it("should check index set membership correctly", () => {
    const { indexSetContains } = require("./utils/negRisk.js");

    // indexSet = 5 (binary 101) → contains 0 and 2, not 1
    expect(indexSetContains(5n, 0)).toBe(true);
    expect(indexSetContains(5n, 1)).toBe(false);
    expect(indexSetContains(5n, 2)).toBe(true);

    // indexSet = 7 (binary 111) → contains 0, 1, 2
    expect(indexSetContains(7n, 0)).toBe(true);
    expect(indexSetContains(7n, 1)).toBe(true);
    expect(indexSetContains(7n, 2)).toBe(true);
  });
});

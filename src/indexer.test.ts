import { describe, it, expect } from "vitest";
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
    const seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID });

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
    const seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID });

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
    let seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID });
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
    let seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID });
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
    const seededDb = mockDb.entities.Condition.set({ id: MOCK_CONDITION_ID });

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
  it("should create FixedProductMarketMaker entity", async () => {
    const mockDb = MockDb.createMockDb();
    const fpmmAddr = Addresses.mockAddresses[0]!;

    const mockEvent =
      FPMMFactory.FixedProductMarketMakerCreation.createMockEvent({
        creator: Addresses.mockAddresses[1]!,
        fixedProductMarketMaker: fpmmAddr,
        conditionalTokens: Addresses.mockAddresses[2]!,
        collateralToken: MOCK_USDC,
        conditionIds: [MOCK_CONDITION_ID],
        fee: 2000n,
      });

    const result =
      await FPMMFactory.FixedProductMarketMakerCreation.processEvent({
        event: mockEvent,
        mockDb,
      });

    const fpmm = result.entities.FixedProductMarketMaker.get(fpmmAddr);
    expect(fpmm).toBeDefined();
    expect(fpmm!.id).toBe(fpmmAddr);
  });
});

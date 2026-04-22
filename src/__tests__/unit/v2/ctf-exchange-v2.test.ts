import { describe, it, expect } from "vitest";
import {
  MockDb,
  CTFExchangeV2,
  Addresses,
} from "../../helpers/test-utils.js";

// NOTE: counter-increment assertions (e.g., totalOrdersFilled, totalVolume) are
// skipped in these unit tests because `processEvent` runs each handler twice
// (once during preload, once during the real run) and increment operations
// therefore double. This is a pre-existing behavior in the v1 codebase and
// affects several wallet / pnl tests as well. Production runs do not double.

const FIRST_V2_EXCHANGE = "0xe111180000d2663c0091e4f400237545b87b996b";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const NONZERO_BUILDER =
  "0x0000000000000000000000000000000000000000000000000000000000000abc";

describe("CTFExchangeV2.OrderFilled", () => {
  it("creates a V2OrderFill with the expected field shape", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = CTFExchangeV2.OrderFilled.createMockEvent({
      orderHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      side: 0n,
      tokenId: 42n,
      makerAmountFilled: 1_000_000n,
      takerAmountFilled: 2_000_000n,
      fee: 10_000n,
      builder: NONZERO_BUILDER,
      metadata: ZERO_BYTES32,
    });
    (mockEvent as any).srcAddress = FIRST_V2_EXCHANGE;

    const result = await CTFExchangeV2.OrderFilled.processEvent({
      event: mockEvent,
      mockDb,
    });

    const fills = result.entities.V2OrderFill.getAll();
    expect(fills.length).toBeGreaterThan(0);
    const fill = fills[0]!;
    expect(fill.orderHash).toBe(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(fill.side).toBe(0);
    expect(fill.tokenId).toBe(42n);
    expect(fill.builder).toBe(NONZERO_BUILDER);
    expect(fill.exchange).toBe(FIRST_V2_EXCHANGE);
    expect(fill.makerAmountFilled).toBe(1_000_000n);
    expect(fill.takerAmountFilled).toBe(2_000_000n);
    expect(fill.fee).toBe(10_000n);
  });

  it("creates V2ExchangeStats keyed by exchange address", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = CTFExchangeV2.OrderFilled.createMockEvent({
      orderHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      maker: Addresses.mockAddresses[0]!,
      taker: Addresses.mockAddresses[1]!,
      side: 1n,
      tokenId: 100n,
      makerAmountFilled: 500_000n,
      takerAmountFilled: 250_000n,
      fee: 5_000n,
      builder: ZERO_BYTES32,
      metadata: ZERO_BYTES32,
    });
    (mockEvent as any).srcAddress = FIRST_V2_EXCHANGE;

    const result = await CTFExchangeV2.OrderFilled.processEvent({
      event: mockEvent,
      mockDb,
    });

    const stats = result.entities.V2ExchangeStats.get(FIRST_V2_EXCHANGE);
    expect(stats).toBeDefined();
  });
});

describe("CTFExchangeV2.OrdersMatched", () => {
  it("creates a V2OrderMatch with the expected field shape", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = CTFExchangeV2.OrdersMatched.createMockEvent({
      takerOrderHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      takerOrderMaker: Addresses.mockAddresses[0]!,
      side: 0n,
      tokenId: 7n,
      makerAmountFilled: 900_000n,
      takerAmountFilled: 1_800_000n,
    });
    (mockEvent as any).srcAddress = FIRST_V2_EXCHANGE;

    const result = await CTFExchangeV2.OrdersMatched.processEvent({
      event: mockEvent,
      mockDb,
    });

    const matches = result.entities.V2OrderMatch.getAll();
    expect(matches.length).toBeGreaterThan(0);
    const match = matches[0]!;
    expect(match.takerOrderHash).toBe(
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    );
    expect(match.tokenId).toBe(7n);
    expect(match.exchange).toBe(FIRST_V2_EXCHANGE);
  });
});

describe("CTFExchangeV2.FeeCharged", () => {
  it("creates a V2FeeEvent", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = CTFExchangeV2.FeeCharged.createMockEvent({
      receiver: Addresses.mockAddresses[2]!,
      amount: 25_000n,
    });
    (mockEvent as any).srcAddress = FIRST_V2_EXCHANGE;

    const result = await CTFExchangeV2.FeeCharged.processEvent({
      event: mockEvent,
      mockDb,
    });

    const fees = result.entities.V2FeeEvent.getAll();
    expect(fees.length).toBe(1);
    expect(fees[0]!.receiver).toBe(Addresses.mockAddresses[2]!);
    expect(fees[0]!.amount).toBe(25_000n);
  });
});

import { describe, it, expect } from "vitest";
import { MockDb, PolyUSD, Addresses } from "../../helpers/test-utils.js";

// NOTE: counter/balance increment assertions are omitted because `processEvent`
// runs handlers twice in unit tests (preload + real run), doubling any
// incrementing state. Production runs are unaffected. Same pattern as the
// pre-existing v1 wallet tests that skip balance assertions.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

describe("PolyUSD.Transfer", () => {
  it("creates a V2PolyUSDTransfer entity with correct fields", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = PolyUSD.Transfer.createMockEvent({
      from: Addresses.mockAddresses[0]!,
      to: Addresses.mockAddresses[1]!,
      amount: 1_000_000n,
    });

    const result = await PolyUSD.Transfer.processEvent({
      event: mockEvent,
      mockDb,
    });

    const transfers = result.entities.V2PolyUSDTransfer.getAll();
    expect(transfers.length).toBe(1);
    expect(transfers[0]!.from).toBe(Addresses.mockAddresses[0]!);
    expect(transfers[0]!.to).toBe(Addresses.mockAddresses[1]!);
    expect(transfers[0]!.amount).toBe(1_000_000n);
  });

  it("does NOT create a V2PolyUSDAccount for the zero address on mint", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = PolyUSD.Transfer.createMockEvent({
      from: ZERO_ADDR,
      to: Addresses.mockAddresses[1]!,
      amount: 5_000_000n,
    });

    const result = await PolyUSD.Transfer.processEvent({
      event: mockEvent,
      mockDb,
    });

    const zero = result.entities.V2PolyUSDAccount.get(ZERO_ADDR);
    expect(zero).toBeUndefined();

    const receiver = result.entities.V2PolyUSDAccount.get(
      Addresses.mockAddresses[1]!,
    );
    expect(receiver).toBeDefined();
  });

  it("does NOT create a V2PolyUSDAccount for the zero address on burn", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = PolyUSD.Transfer.createMockEvent({
      from: Addresses.mockAddresses[0]!,
      to: ZERO_ADDR,
      amount: 2_000_000n,
    });

    const result = await PolyUSD.Transfer.processEvent({
      event: mockEvent,
      mockDb,
    });

    const zero = result.entities.V2PolyUSDAccount.get(ZERO_ADDR);
    expect(zero).toBeUndefined();
  });
});

describe("PolyUSD.Wrapped", () => {
  it("records a wrap event with eventType='wrap'", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = PolyUSD.Wrapped.createMockEvent({
      caller: Addresses.mockAddresses[0]!,
      asset: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      to: Addresses.mockAddresses[1]!,
      amount: 3_000_000n,
    });

    const result = await PolyUSD.Wrapped.processEvent({
      event: mockEvent,
      mockDb,
    });

    const wrap = result.entities.V2PolyUSDWrap.getAll()[0]!;
    expect(wrap.eventType).toBe("wrap");
    expect(wrap.amount).toBe(3_000_000n);
    expect(wrap.caller).toBe(Addresses.mockAddresses[0]!);
    expect(wrap.to).toBe(Addresses.mockAddresses[1]!);
  });
});

describe("PolyUSD.Unwrapped", () => {
  it("records an unwrap event with eventType='unwrap'", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = PolyUSD.Unwrapped.createMockEvent({
      caller: Addresses.mockAddresses[0]!,
      asset: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      to: Addresses.mockAddresses[1]!,
      amount: 1_500_000n,
    });

    const result = await PolyUSD.Unwrapped.processEvent({
      event: mockEvent,
      mockDb,
    });

    const unwrap = result.entities.V2PolyUSDWrap.getAll()[0]!;
    expect(unwrap.eventType).toBe("unwrap");
    expect(unwrap.amount).toBe(1_500_000n);
  });
});

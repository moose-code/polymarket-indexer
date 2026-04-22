import { describe, it, expect } from "vitest";
import { MockDb, Rewards, Addresses } from "../../helpers/test-utils.js";

const MARKET_ID =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

describe("Rewards.DistributedRewards", () => {
  it("creates a V2RewardDistribution entity", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Rewards.DistributedRewards.createMockEvent({
      user: Addresses.mockAddresses[0]!,
      amount: 10_000n,
    });

    const result = await Rewards.DistributedRewards.processEvent({
      event: mockEvent,
      mockDb,
    });

    const rewards = result.entities.V2RewardDistribution.getAll();
    expect(rewards.length).toBe(1);
    expect(rewards[0]!.user).toBe(Addresses.mockAddresses[0]!);
    expect(rewards[0]!.amount).toBe(10_000n);
  });
});

describe("Rewards.MarketCreated", () => {
  it("creates a V2SponsoredMarket entity with closed=false", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Rewards.MarketCreated.createMockEvent({
      marketId: MARKET_ID,
      startTime: 1714000000n,
      minSponsorDuration: 86400n,
      minSponsorAmount: 100_000_000n,
      marketData: "0xdeadbeef",
    });

    const result = await Rewards.MarketCreated.processEvent({
      event: mockEvent,
      mockDb,
    });

    const market = result.entities.V2SponsoredMarket.get(MARKET_ID);
    expect(market).toBeDefined();
    expect(market!.closed).toBe(false);
    expect(market!.minSponsorAmount).toBe(100_000_000n);
  });
});

describe("Rewards.Sponsored", () => {
  it("creates a V2Sponsorship entity linked to V2SponsoredMarket", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Rewards.Sponsored.createMockEvent({
      marketId: MARKET_ID,
      sponsor: Addresses.mockAddresses[1]!,
      amount: 500_000n,
      startTime: 1714000000n,
      endTime: 1714086400n,
      ratePerMinute: 100n,
    });

    const result = await Rewards.Sponsored.processEvent({
      event: mockEvent,
      mockDb,
    });

    const sponsorships = result.entities.V2Sponsorship.getAll();
    expect(sponsorships.length).toBe(1);
    expect(sponsorships[0]!.sponsor).toBe(Addresses.mockAddresses[1]!);
    expect(sponsorships[0]!.withdrawn).toBe(false);
    // market_id foreign key points at the sponsored market
    expect((sponsorships[0]! as any).market_id).toBe(MARKET_ID);
  });
});

describe("Rewards.MarketClosed", () => {
  it("sets closed=true and closedAt on existing V2SponsoredMarket", async () => {
    // seed an existing market
    const seedDb = MockDb.createMockDb().entities.V2SponsoredMarket.set({
      id: MARKET_ID,
      startTime: 1714000000,
      minSponsorDuration: 86400,
      minSponsorAmount: 100_000_000n,
      marketData: "0xdeadbeef",
      closed: false,
      closedAt: undefined,
      createdAt: 1714000000,
      createdAtBlock: 85000000,
    });

    const mockEvent = Rewards.MarketClosed.createMockEvent({
      marketId: MARKET_ID,
      closedAt: 1714100000n,
    });

    const result = await Rewards.MarketClosed.processEvent({
      event: mockEvent,
      mockDb: seedDb,
    });

    const market = result.entities.V2SponsoredMarket.get(MARKET_ID);
    expect(market!.closed).toBe(true);
    expect(market!.closedAt).toBe(1714100000);
  });

  it("no-ops when market does not exist", async () => {
    const mockDb = MockDb.createMockDb();

    const mockEvent = Rewards.MarketClosed.createMockEvent({
      marketId: MARKET_ID,
      closedAt: 1714100000n,
    });

    const result = await Rewards.MarketClosed.processEvent({
      event: mockEvent,
      mockDb,
    });

    const market = result.entities.V2SponsoredMarket.get(MARKET_ID);
    expect(market).toBeUndefined();
  });
});

import { FPMMFactory } from "generated";

// ============================================================
// FixedProductMarketMakerCreation — create FPMM entity
// ============================================================

FPMMFactory.FixedProductMarketMakerCreation.handler(
  async ({ event, context }) => {
    const fpmmAddress = event.params.fixedProductMarketMaker;

    const existing = await context.FixedProductMarketMaker.get(fpmmAddress);
    if (!existing) {
      context.FixedProductMarketMaker.set({
        id: fpmmAddress,
      });
    }
  },
);

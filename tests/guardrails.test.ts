import { describe, expect, test } from "bun:test";
import {
  checkOrder,
  dailyStopBreached,
  dayPnlPct,
  DEFAULT_GUARDRAILS,
  killSwitchBreached,
  type AccountState,
  type OrderIntent,
} from "../src/guardrails.ts";

function buyIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return { ticker: "NVDA", side: "buy", amountUsd: 40, shares: null, hasStopLoss: true, ...overrides };
}

function state(overrides: Partial<AccountState> = {}): AccountState {
  return {
    initialCapital: 150,
    equity: 150,
    cash: 150,
    dayStartEquity: 150,
    ordersToday: 0,
    buysFrozen: false,
    killSwitchActive: false,
    positions: [],
    asset: { inCatalog: true, price: 100, assetType: "Stock" },
    ...overrides,
  };
}

describe("happy path", () => {
  test("clean buy passes", () => {
    expect(checkOrder(buyIntent(), state())).toEqual({ ok: true });
  });
  test("sell of existing position passes", () => {
    const s = state({ positions: [{ ticker: "NVDA", shares: 1, costBasis: 100, marketValue: 100 }] });
    expect(checkOrder({ ticker: "NVDA", side: "sell", amountUsd: null, shares: 1, hasStopLoss: false }, s)).toEqual({ ok: true });
  });
});

describe("kill switch", () => {
  test("flag blocks everything including sells", () => {
    const s = state({ killSwitchActive: true, positions: [{ ticker: "NVDA", shares: 1, costBasis: 100, marketValue: 100 }] });
    expect(checkOrder(buyIntent(), s)).toMatchObject({ ok: false, code: "kill_switch" });
    expect(checkOrder({ ticker: "NVDA", side: "sell", amountUsd: null, shares: 1, hasStopLoss: false }, s)).toMatchObject({
      ok: false,
      code: "kill_switch",
    });
  });
  test("equity below 65% of capital trips it", () => {
    expect(killSwitchBreached(state({ equity: 97.4 }), DEFAULT_GUARDRAILS)).toBe(true);
    expect(killSwitchBreached(state({ equity: 97.5 }), DEFAULT_GUARDRAILS)).toBe(false);
    expect(checkOrder(buyIntent(), state({ equity: 90 }))).toMatchObject({ ok: false, code: "kill_switch" });
  });
});

describe("daily stop", () => {
  test("dayPnlPct math", () => {
    expect(dayPnlPct(state({ equity: 138, dayStartEquity: 150 }))).toBeCloseTo(-0.08);
    expect(dayPnlPct(state({ dayStartEquity: null }))).toBeNull();
  });
  test("-8% exactly breaches", () => {
    expect(dailyStopBreached(state({ equity: 138, dayStartEquity: 150 }), DEFAULT_GUARDRAILS)).toBe(true);
    expect(dailyStopBreached(state({ equity: 138.1, dayStartEquity: 150 }), DEFAULT_GUARDRAILS)).toBe(false);
  });
  test("blocks buys, not sells", () => {
    const s = state({
      equity: 130,
      dayStartEquity: 150,
      positions: [{ ticker: "NVDA", shares: 1, costBasis: 100, marketValue: 100 }],
    });
    expect(checkOrder(buyIntent(), s)).toMatchObject({ ok: false, code: "daily_stop" });
    expect(checkOrder({ ticker: "NVDA", side: "sell", amountUsd: null, shares: 1, hasStopLoss: false }, s)).toEqual({ ok: true });
  });
  test("buysFrozen flag blocks buys", () => {
    expect(checkOrder(buyIntent(), state({ buysFrozen: true }))).toMatchObject({ ok: false, code: "daily_stop" });
  });
});

describe("order cap", () => {
  test("8th order blocked, 7th allowed", () => {
    expect(checkOrder(buyIntent(), state({ ordersToday: 7 }))).toEqual({ ok: true });
    expect(checkOrder(buyIntent(), state({ ordersToday: 8 }))).toMatchObject({ ok: false, code: "max_orders" });
  });
  test("sells exempt from the cap", () => {
    const s = state({ ordersToday: 20, positions: [{ ticker: "NVDA", shares: 1, costBasis: 100, marketValue: 100 }] });
    expect(checkOrder({ ticker: "NVDA", side: "sell", amountUsd: null, shares: 1, hasStopLoss: false }, s)).toEqual({ ok: true });
  });
});

describe("stop loss requirement", () => {
  test("buy without stop rejected", () => {
    expect(checkOrder(buyIntent({ hasStopLoss: false }), state())).toMatchObject({ ok: false, code: "missing_stop_loss" });
  });
});

describe("universe", () => {
  test("not in catalog rejected", () => {
    expect(checkOrder(buyIntent(), state({ asset: { inCatalog: false, price: 100, assetType: null } }))).toMatchObject({
      ok: false,
      code: "not_in_catalog",
    });
    expect(checkOrder(buyIntent(), state({ asset: null }))).toMatchObject({ ok: false, code: "not_in_catalog" });
  });
  test("penny stock rejected at $5 boundary", () => {
    expect(checkOrder(buyIntent(), state({ asset: { inCatalog: true, price: 5, assetType: "Stock" } }))).toMatchObject({
      ok: false,
      code: "penny_stock",
    });
    expect(checkOrder(buyIntent(), state({ asset: { inCatalog: true, price: 5.01, assetType: "Stock" } }))).toEqual({ ok: true });
  });
});

describe("capital limits", () => {
  test("insufficient cash", () => {
    expect(checkOrder(buyIntent({ amountUsd: 60 }), state({ cash: 50 }))).toMatchObject({ ok: false, code: "insufficient_cash" });
  });
  test("max invested = initial capital", () => {
    const s = state({
      cash: 100,
      positions: [{ ticker: "AAPL", shares: 1, costBasis: 120, marketValue: 125 }],
    });
    expect(checkOrder(buyIntent({ amountUsd: 40 }), s)).toMatchObject({ ok: false, code: "max_invested" });
    expect(checkOrder(buyIntent({ amountUsd: 30 }), s)).toEqual({ ok: true });
  });
  test("position cap 40% of capital", () => {
    const s = state({
      positions: [{ ticker: "NVDA", shares: 0.5, costBasis: 50, marketValue: 50 }],
      cash: 100,
    });
    // cap = 60; existing 50 -> max extra 10
    expect(checkOrder(buyIntent({ amountUsd: 10 }), s)).toEqual({ ok: true });
    expect(checkOrder(buyIntent({ amountUsd: 10.5 }), s)).toMatchObject({ ok: false, code: "position_cap" });
  });
  test("fresh ticker capped at 40% too", () => {
    expect(checkOrder(buyIntent({ amountUsd: 60 }), state({ cash: 150 }))).toEqual({ ok: true });
    expect(checkOrder(buyIntent({ amountUsd: 61 }), state({ cash: 150 }))).toMatchObject({ ok: false, code: "position_cap" });
  });
  test("tiny order rejected", () => {
    expect(checkOrder(buyIntent({ amountUsd: 0.5 }), state())).toMatchObject({ ok: false, code: "bad_amount" });
    expect(checkOrder(buyIntent({ amountUsd: null }), state())).toMatchObject({ ok: false, code: "bad_amount" });
  });
});

describe("sells", () => {
  test("sell without position rejected", () => {
    expect(checkOrder({ ticker: "TSLA", side: "sell", amountUsd: null, shares: 1, hasStopLoss: false }, state())).toMatchObject({
      ok: false,
      code: "no_position",
    });
  });
});

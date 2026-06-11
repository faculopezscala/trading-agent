import { describe, expect, test } from "bun:test";
import { etParts } from "../src/market.ts";
import {
  evaluateRule,
  evaluateTrigger,
  extractJsonBlock,
  isExpired,
  parsePlanJson,
  parseTrigger,
  PlanSchema,
  pctChangeToday,
  type EvalContext,
  type Quote,
} from "../src/rules.ts";

function quote(price: number, prevClose: number | null = null): Quote {
  return { ticker: "TEST", price, prevClose, dayOpen: null, ts: Date.now(), source: "test" };
}

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  const now = new Date("2026-06-10T15:00:00Z"); // 11:00 ET Wednesday
  return {
    quote: quote(100, 100),
    nowEt: etParts(now),
    now,
    marketJustOpened: false,
    ...overrides,
  };
}

describe("price triggers", () => {
  test("price_below fires at or below value", () => {
    expect(evaluateTrigger({ type: "price_below", value: 100 }, ctx({ quote: quote(100) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "price_below", value: 100 }, ctx({ quote: quote(99.99) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "price_below", value: 100 }, ctx({ quote: quote(100.01) })).fire).toBe(false);
  });
  test("price_above fires at or above value", () => {
    expect(evaluateTrigger({ type: "price_above", value: 100 }, ctx({ quote: quote(100) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "price_above", value: 100 }, ctx({ quote: quote(100.01) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "price_above", value: 100 }, ctx({ quote: quote(99.99) })).fire).toBe(false);
  });
  test("no quote never fires", () => {
    expect(evaluateTrigger({ type: "price_below", value: 100 }, ctx({ quote: null })).fire).toBe(false);
    expect(evaluateTrigger({ type: "price_above", value: 100 }, ctx({ quote: null })).fire).toBe(false);
  });
});

describe("pct change triggers", () => {
  test("pctChangeToday math", () => {
    expect(pctChangeToday(quote(97, 100))).toBeCloseTo(-3);
    expect(pctChangeToday(quote(103, 100))).toBeCloseTo(3);
    expect(pctChangeToday(quote(100, null))).toBeNull();
  });
  test("below fires when down enough", () => {
    expect(evaluateTrigger({ type: "pct_change_intraday_below", value: -3 }, ctx({ quote: quote(97, 100) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "pct_change_intraday_below", value: -3 }, ctx({ quote: quote(96, 100) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "pct_change_intraday_below", value: -3 }, ctx({ quote: quote(97.5, 100) })).fire).toBe(false);
  });
  test("above fires when up enough", () => {
    expect(evaluateTrigger({ type: "pct_change_intraday_above", value: 2 }, ctx({ quote: quote(102, 100) })).fire).toBe(true);
    expect(evaluateTrigger({ type: "pct_change_intraday_above", value: 2 }, ctx({ quote: quote(101.9, 100) })).fire).toBe(false);
  });
  test("no prevClose degrades to not firing", () => {
    expect(evaluateTrigger({ type: "pct_change_intraday_below", value: -3 }, ctx({ quote: quote(50, null) })).fire).toBe(false);
  });
});

describe("market_open trigger", () => {
  test("fires on first tick after open", () => {
    const now = new Date("2026-06-10T13:31:00Z"); // 9:31 ET
    expect(evaluateTrigger({ type: "market_open" }, ctx({ now, nowEt: etParts(now), marketJustOpened: true })).fire).toBe(true);
  });
  test("fires within first 30 minutes even after restart", () => {
    const now = new Date("2026-06-10T13:55:00Z"); // 9:55 ET
    expect(evaluateTrigger({ type: "market_open" }, ctx({ now, nowEt: etParts(now), marketJustOpened: false })).fire).toBe(true);
  });
  test("does not fire late in the day without the flag", () => {
    const now = new Date("2026-06-10T15:00:00Z"); // 11:00 ET
    expect(evaluateTrigger({ type: "market_open" }, ctx({ now, nowEt: etParts(now), marketJustOpened: false })).fire).toBe(false);
  });
});

describe("time_at trigger", () => {
  test("fires at and after the target ET time", () => {
    const at1059 = new Date("2026-06-10T14:59:00Z");
    const at1100 = new Date("2026-06-10T15:00:00Z");
    expect(evaluateTrigger({ type: "time_at", value: "11:00" }, ctx({ now: at1059, nowEt: etParts(at1059) })).fire).toBe(false);
    expect(evaluateTrigger({ type: "time_at", value: "11:00" }, ctx({ now: at1100, nowEt: etParts(at1100) })).fire).toBe(true);
  });
});

describe("expiry", () => {
  test("isExpired boundaries", () => {
    const now = new Date("2026-06-10T15:00:00Z");
    expect(isExpired("2026-06-10T14:59:00Z", now)).toBe(true);
    expect(isExpired("2026-06-10T15:00:00Z", now)).toBe(false);
    expect(isExpired("garbage", now)).toBe(true);
  });
  test("evaluateRule returns expired before evaluating trigger", () => {
    const decision = evaluateRule(
      {
        id: "x",
        ticker: "TEST",
        action: "buy",
        trigger: { type: "price_below", value: 1000 },
        amountUsd: 10,
        validUntil: "2026-06-10T14:00:00Z",
        stopLoss: null,
        takeProfit: null,
      },
      ctx(),
    );
    expect(decision.kind).toBe("expired");
  });
});

describe("PlanSchema validation", () => {
  const validPlan = {
    date: "2026-06-10",
    thesis: "test thesis",
    rules: [
      {
        id: "nvda-1",
        ticker: "nvda",
        action: "buy",
        trigger: { type: "price_below", value: 142.5 },
        amountUsd: 40,
        validUntil: "2026-06-10T16:00:00-04:00",
        stopLoss: { type: "price_below", value: 135 },
        takeProfit: { type: "price_above", value: 155 },
        reason: "momentum",
      },
    ],
    exits: [
      {
        id: "exit-aapl",
        ticker: "AAPL",
        action: "sell",
        trigger: { type: "pct_change_intraday_above", value: 4 },
        validUntil: "2026-06-10T16:00:00-04:00",
        reason: "take the pop",
      },
    ],
  };

  test("valid plan parses and uppercases tickers", () => {
    const plan = PlanSchema.parse(validPlan);
    expect(plan.rules[0]!.ticker).toBe("NVDA");
    expect(plan.exits[0]!.ticker).toBe("AAPL");
  });

  test("buy without stopLoss is rejected", () => {
    const bad = structuredClone(validPlan) as Record<string, unknown>;
    delete ((bad.rules as Record<string, unknown>[])[0] as Record<string, unknown>).stopLoss;
    expect(() => PlanSchema.parse(bad)).toThrow();
  });

  test("stopLoss of wrong direction is rejected", () => {
    const bad = structuredClone(validPlan);
    (bad.rules[0] as { stopLoss: unknown }).stopLoss = { type: "price_above", value: 135 };
    expect(() => PlanSchema.parse(bad)).toThrow();
  });

  test("stopLoss above buy trigger is rejected", () => {
    const bad = structuredClone(validPlan);
    (bad.rules[0] as { stopLoss: { value: number } }).stopLoss.value = 150;
    expect(() => PlanSchema.parse(bad)).toThrow();
  });

  test("duplicate rule ids rejected", () => {
    const bad = structuredClone(validPlan);
    (bad.exits[0] as { id: string }).id = "nvda-1";
    expect(() => PlanSchema.parse(bad)).toThrow();
  });

  test("negative amount rejected", () => {
    const bad = structuredClone(validPlan);
    (bad.rules[0] as { amountUsd: number }).amountUsd = -5;
    expect(() => PlanSchema.parse(bad)).toThrow();
  });

  test("bad time_at value rejected", () => {
    const bad = structuredClone(validPlan);
    (bad.exits[0] as { trigger: unknown }).trigger = { type: "time_at", value: "25:99" };
    expect(() => PlanSchema.parse(bad)).toThrow();
  });

  test("empty rules (no-trade day) is valid", () => {
    const plan = PlanSchema.parse({ ...validPlan, rules: [], exits: [] });
    expect(plan.rules).toHaveLength(0);
  });

  test("parsePlanJson roundtrip", () => {
    const plan = parsePlanJson(JSON.stringify(validPlan));
    expect(plan.date).toBe("2026-06-10");
  });
});

describe("extractJsonBlock", () => {
  test("fenced json block", () => {
    const text = 'journal text\n```json\n{"a": 1}\n```\ntrailing';
    expect(extractJsonBlock(text)).toBe('{"a": 1}');
  });
  test("unfenced object with nested braces", () => {
    const text = 'hello {"a": {"b": [1,2]}, "c": "x"} bye';
    expect(JSON.parse(extractJsonBlock(text)!)).toEqual({ a: { b: [1, 2] }, c: "x" });
  });
  test("braces inside strings do not break depth tracking", () => {
    const text = '{"msg": "look {at} this \\" quote"}';
    expect(JSON.parse(extractJsonBlock(text)!)).toEqual({ msg: 'look {at} this " quote' });
  });
  test("no json returns null", () => {
    expect(extractJsonBlock("nothing here")).toBeNull();
  });
});

describe("parseTrigger", () => {
  test("valid json", () => {
    expect(parseTrigger('{"type":"price_below","value":10}')).toEqual({ type: "price_below", value: 10 });
  });
  test("invalid json returns null", () => {
    expect(parseTrigger("{broken")).toBeNull();
    expect(parseTrigger('{"type":"unknown","value":1}')).toBeNull();
    expect(parseTrigger(null)).toBeNull();
  });
});

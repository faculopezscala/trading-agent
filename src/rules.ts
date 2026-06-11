import { z } from "zod";
import { MARKET_OPEN_MIN, parseTimeAt, type ETParts } from "./market.ts";

// ---------------------------------------------------------------------------
// Trigger and plan schemas. The planner LLM emits this JSON; everything here
// must be evaluable deterministically without any model in the loop.
// ---------------------------------------------------------------------------

export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("price_below"), value: z.number().positive() }),
  z.object({ type: z.literal("price_above"), value: z.number().positive() }),
  // pct change vs previous close, e.g. value -3 = down 3% or more on the day
  z.object({ type: z.literal("pct_change_intraday_below"), value: z.number() }),
  z.object({ type: z.literal("pct_change_intraday_above"), value: z.number() }),
  z.object({ type: z.literal("market_open") }),
  // "HH:MM" 24h ET
  z.object({
    type: z.literal("time_at"),
    value: z.string().refine((v) => parseTimeAt(v) !== null, "time_at value must be HH:MM (ET)"),
  }),
]);

export type Trigger = z.infer<typeof TriggerSchema>;

const TickerSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.]{0,9}$/, "invalid ticker");

export const BuyRuleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  ticker: TickerSchema,
  action: z.literal("buy"),
  trigger: TriggerSchema,
  amountUsd: z.number().positive(),
  validUntil: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "validUntil must be ISO datetime"),
  stopLoss: TriggerSchema,
  takeProfit: TriggerSchema.optional(),
  reason: z.string().max(500).optional().default(""),
});

export const SellRuleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  ticker: TickerSchema,
  action: z.literal("sell"),
  trigger: TriggerSchema,
  // optional: sell only this many USD worth; full position when omitted
  amountUsd: z.number().positive().optional(),
  validUntil: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "validUntil must be ISO datetime"),
  reason: z.string().max(500).optional().default(""),
});

export const PlanSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    thesis: z.string().min(1).max(1200),
    rules: z.array(BuyRuleSchema).max(12),
    exits: z.array(SellRuleSchema).max(12),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const r of [...plan.rules, ...plan.exits]) {
      if (ids.has(r.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate rule id: ${r.id}` });
      }
      ids.add(r.id);
    }
    for (const r of plan.rules) {
      if (r.stopLoss.type !== "price_below" && r.stopLoss.type !== "pct_change_intraday_below") {
        ctx.addIssue({ code: "custom", message: `rule ${r.id}: stopLoss must be price_below or pct_change_intraday_below` });
      }
      if (r.takeProfit && r.takeProfit.type !== "price_above" && r.takeProfit.type !== "pct_change_intraday_above") {
        ctx.addIssue({ code: "custom", message: `rule ${r.id}: takeProfit must be price_above or pct_change_intraday_above` });
      }
      if (r.stopLoss.type === "price_below" && r.trigger.type === "price_below" && r.stopLoss.value >= r.trigger.value) {
        ctx.addIssue({ code: "custom", message: `rule ${r.id}: stopLoss must be below the buy trigger price` });
      }
    }
  });

export type Plan = z.infer<typeof PlanSchema>;
export type BuyRule = z.infer<typeof BuyRuleSchema>;
export type SellRule = z.infer<typeof SellRuleSchema>;

// Mid-day adjustment payload: can only touch existing rules and add exits.
export const MiddayAdjustmentSchema = z.object({
  comment: z.string().max(1200).optional().default(""),
  cancelRuleIds: z.array(z.string()).max(20).optional().default([]),
  newExits: z.array(SellRuleSchema).max(8).optional().default([]),
});
export type MiddayAdjustment = z.infer<typeof MiddayAdjustmentSchema>;

// ---------------------------------------------------------------------------
// Evaluation engine
// ---------------------------------------------------------------------------

export interface Quote {
  ticker: string;
  price: number;
  prevClose: number | null;
  dayOpen: number | null;
  ts: number; // ms epoch of the quote
  source: string;
}

export interface EvalContext {
  quote: Quote | null;
  nowEt: ETParts;
  now: Date;
  // true only on the executor's first tick after the open
  marketJustOpened: boolean;
}

export interface EvalResult {
  fire: boolean;
  reason: string;
}

export function pctChangeToday(quote: Quote): number | null {
  if (quote.prevClose === null || quote.prevClose === 0) return null;
  return ((quote.price - quote.prevClose) / quote.prevClose) * 100;
}

export function evaluateTrigger(trigger: Trigger, ctx: EvalContext): EvalResult {
  switch (trigger.type) {
    case "price_below": {
      if (!ctx.quote) return { fire: false, reason: "no quote" };
      const fire = ctx.quote.price <= trigger.value;
      return { fire, reason: `price ${ctx.quote.price} <= ${trigger.value} = ${fire}` };
    }
    case "price_above": {
      if (!ctx.quote) return { fire: false, reason: "no quote" };
      const fire = ctx.quote.price >= trigger.value;
      return { fire, reason: `price ${ctx.quote.price} >= ${trigger.value} = ${fire}` };
    }
    case "pct_change_intraday_below": {
      if (!ctx.quote) return { fire: false, reason: "no quote" };
      const pct = pctChangeToday(ctx.quote);
      if (pct === null) return { fire: false, reason: "no prevClose" };
      const fire = pct <= trigger.value;
      return { fire, reason: `pct ${pct.toFixed(2)} <= ${trigger.value} = ${fire}` };
    }
    case "pct_change_intraday_above": {
      if (!ctx.quote) return { fire: false, reason: "no quote" };
      const pct = pctChangeToday(ctx.quote);
      if (pct === null) return { fire: false, reason: "no prevClose" };
      const fire = pct >= trigger.value;
      return { fire, reason: `pct ${pct.toFixed(2)} >= ${trigger.value} = ${fire}` };
    }
    case "market_open": {
      // Fires on the first tick at/after the open. Rule status handles idempotency,
      // and we tolerate process restarts within the first 30 minutes.
      const fire = ctx.marketJustOpened || (ctx.nowEt.minutesOfDay >= MARKET_OPEN_MIN && ctx.nowEt.minutesOfDay < MARKET_OPEN_MIN + 30);
      return { fire, reason: `market_open at ${ctx.nowEt.minutesOfDay}min = ${fire}` };
    }
    case "time_at": {
      const target = parseTimeAt(trigger.value);
      if (target === null) return { fire: false, reason: "bad time_at value" };
      const fire = ctx.nowEt.minutesOfDay >= target;
      return { fire, reason: `time ${ctx.nowEt.minutesOfDay} >= ${target} = ${fire}` };
    }
  }
}

export function isExpired(validUntil: string, now: Date): boolean {
  const t = Date.parse(validUntil);
  if (Number.isNaN(t)) return true;
  return now.getTime() > t;
}

export interface StoredRule {
  id: string;
  ticker: string;
  action: "buy" | "sell";
  trigger: Trigger;
  amountUsd: number | null;
  validUntil: string;
  stopLoss: Trigger | null;
  takeProfit: Trigger | null;
}

export type RuleDecision =
  | { kind: "fire"; reason: string }
  | { kind: "expired" }
  | { kind: "hold"; reason: string };

export function evaluateRule(rule: StoredRule, ctx: EvalContext): RuleDecision {
  if (isExpired(rule.validUntil, ctx.now)) return { kind: "expired" };
  const res = evaluateTrigger(rule.trigger, ctx);
  if (res.fire) return { kind: "fire", reason: res.reason };
  return { kind: "hold", reason: res.reason };
}

// Human-readable trigger description, used in manual-execution signals.
export function describeTrigger(t: Trigger | null): string {
  if (!t) return "sin definir";
  switch (t.type) {
    case "price_below":
      return `precio <= $${t.value.toFixed(2)}`;
    case "price_above":
      return `precio >= $${t.value.toFixed(2)}`;
    case "pct_change_intraday_below":
      return `${t.value}% o peor vs cierre previo`;
    case "pct_change_intraday_above":
      return `+${t.value}% o mejor vs cierre previo`;
    case "market_open":
      return "apertura de mercado";
    case "time_at":
      return `a las ${t.value} ET`;
  }
}

// Parse helpers for rows coming from SQLite.
export function parseTrigger(json: string | null): Trigger | null {
  if (!json) return null;
  try {
    return TriggerSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

// Validates raw planner output text -> Plan. Throws ZodError with details.
export function parsePlanJson(raw: string): Plan {
  return PlanSchema.parse(JSON.parse(raw));
}

// Extracts the first JSON object from LLM output (handles ```json fences).
export function extractJsonBlock(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) {
    const candidate = fence[1].trim();
    if (candidate.startsWith("{")) return candidate;
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// The expensive brain. Runs 1-2 times per day: researches with web search,
// emits a machine-readable plan that the executor follows to the letter.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { getDb, type Db } from "./db.ts";
import { initialCapital } from "./executor.ts";
import { callClaude } from "./llm.ts";
import { log } from "./log.ts";
import { etParts, todayET } from "./market.ts";
import { notify } from "./notify.ts";
import { getQuotes } from "./prices.ts";
import {
  extractJsonBlock,
  MiddayAdjustmentSchema,
  PlanSchema,
  type Plan,
} from "./rules.ts";
import { createBroker, type Broker } from "./broker.ts";

const STRATEGY_PATH = "strategy.md";

export function readStrategy(): string {
  if (!existsSync(STRATEGY_PATH)) return "(strategy.md not found - first run)";
  return readFileSync(STRATEGY_PATH, "utf8");
}

export function writeStrategy(content: string) {
  writeFileSync(STRATEGY_PATH, content);
}

// ---------------------------------------------------------------------------
// System prompt: static so it benefits from prompt caching across days.
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = `You are the daily planner of an autonomous trading system running on a real Wallbit brokerage account (US stocks and ETFs, fractional shares, MARKET orders only). Experimental capital: ~100-200 USD. The objective is to BEAT THE MARKET with active picks. This is high-risk capital the owner can afford to lose, but you design every day to win.

You think. A deterministic executor trades. You communicate ONLY through a JSON plan; you have no other influence during the day. Rules you emit are evaluated every 1-2 minutes against live prices and executed mechanically.

TRADING STYLE (mandatory):
- Aggressive, concentrated: 2-4 tickers max in play. No diversification theater.
- Momentum and short-term catalysts: earnings reactions, news, sector moves, oversold bounces.
- FORBIDDEN: recommending passively holding SPY/QQQ or any broad index as the trade. The system exists to beat that.
- Every buy MUST include a stopLoss exit. No exceptions (orders without one are rejected in code).
- "No trade today" is a valid, respected decision when there is no clear setup. Do not trade for the sake of trading. Emit an empty rules array and explain why.
- Protect existing positions: you may add/adjust exits for them every day.

HARD GUARDRAILS (enforced in code, do not plan around them):
- Max 40% of capital in a single position. Max 8 orders/day. Buys without stopLoss rejected.
- Daily loss of -8% freezes buys until tomorrow. Equity below 65% of initial capital freezes everything.
- Only stocks/ETFs in the Wallbit catalog with price > $5.

TRIGGER TYPES (the only vocabulary the executor understands):
- {"type":"price_below","value":N} fires when last price <= N
- {"type":"price_above","value":N} fires when last price >= N
- {"type":"pct_change_intraday_below","value":N} fires when %change vs previous close <= N (e.g. -3 = down 3%+)
- {"type":"pct_change_intraday_above","value":N} fires when %change vs previous close >= N
- {"type":"market_open"} fires on the first executor tick after 9:30 ET
- {"type":"time_at","value":"HH:MM"} fires at that ET time

OUTPUT FORMAT (strict):
1. First: a short journal section in Spanish (plain text, max ~200 words) explaining the day's thesis and the WHY of each rule: what you expect to happen and what invalidates it.
2. Then: exactly one JSON code block with this shape:

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "thesis": "tesis corta del dia en espanol",
  "rules": [
    {
      "id": "nvda-momentum-1",
      "ticker": "NVDA",
      "action": "buy",
      "trigger": {"type": "price_below", "value": 142.50},
      "amountUsd": 40,
      "validUntil": "YYYY-MM-DDT16:00:00-04:00",
      "stopLoss": {"type": "price_below", "value": 135.00},
      "takeProfit": {"type": "price_above", "value": 155.00},
      "reason": "por que esta regla"
    }
  ],
  "exits": [
    {
      "id": "exit-xyz-1",
      "ticker": "XYZ",
      "action": "sell",
      "trigger": {"type": "price_above", "value": 100},
      "validUntil": "YYYY-MM-DDT16:00:00-04:00",
      "reason": "por que vender"
    }
  ]
}
\`\`\`

JSON rules: "rules" contains ONLY buys (action "buy", with amountUsd and stopLoss, both mandatory). ALL sells of any kind go in "exits" (action "sell"; amountUsd optional = partial sell, omitted = full position). Rule ids unique, lowercase-kebab. amountUsd respects available cash and the 40% position cap. stopLoss must be price_below (or pct_change_intraday_below) and below the entry. takeProfit optional but recommended. validUntil usually today's close (16:00 ET, -04:00 in summer, -05:00 in winter). exits[] operate on EXISTING positions only. Keep total output tight; no prose after the JSON block.

Use web search wisely (you have a small budget): check news on current positions first, then watchlist/candidates, earnings calendar and macro events of the day (Fed, CPI, jobs). Prefer fresh, concrete catalysts over vibes.`;

// ---------------------------------------------------------------------------

interface PlannerContext {
  date: string;
  contextBlock: string;
}

export async function buildPlannerContext(db: Db, broker: Broker): Promise<PlannerContext> {
  const date = todayET();
  const positions = db.allPositions();
  const tickers = positions.map((p) => p.ticker);
  const quotes = tickers.length > 0 ? await getQuotes(tickers) : new Map();
  const cash = await broker.getCash().catch(() => null);
  const capital = initialCapital(db);

  const posLines =
    positions.length === 0
      ? "none"
      : positions
          .map((p) => {
            const q = quotes.get(p.ticker);
            const value = p.shares * (q?.price ?? p.avg_cost);
            const pnl = value - p.cost_basis;
            const pnlPct = p.cost_basis > 0 ? (pnl / p.cost_basis) * 100 : 0;
            return `${p.ticker}: ${p.shares.toFixed(6)} sh, avg $${p.avg_cost.toFixed(2)}, now $${q?.price?.toFixed(2) ?? "?"}, value $${value.toFixed(2)}, P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%), stop ${p.stop_loss_json ?? "none"}, tp ${p.take_profit_json ?? "none"}`;
          })
          .join("\n");

  const yesterdayPlan = (() => {
    for (let i = 1; i <= 5; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const ds = todayET(d);
      const plan = db.planForDate(ds);
      if (plan) {
        const stats = db.ruleStats(ds);
        return `Plan ${ds} (${plan.kind}): thesis "${plan.thesis}". Rule outcomes since then: ${stats.map((s) => `${s.status}=${s.n}`).join(", ") || "none"}`;
      }
    }
    return "none (first run or long gap)";
  })();

  const journal = db
    .recentJournal(8)
    .map((j) => `[${j.date} ${j.type}] ${j.content.slice(0, 400)}`)
    .reverse()
    .join("\n");

  const realized = db.realizedTrades(8);
  const realizedLines =
    realized.length === 0
      ? "none yet"
      : realized.map((t) => `${t.closed_at.slice(0, 10)} ${t.ticker} pnl $${t.pnl_usd.toFixed(2)} (${t.reason.slice(0, 60)})`).join("\n");

  const daily = db.getDailyState(date);
  const equitySnapshot = db.latestSnapshot();

  const contextBlock = `TODAY: ${date} (pre-market)
INITIAL CAPITAL: $${capital}
CASH AVAILABLE: ${cash === null ? "unknown (treat conservatively)" : `$${cash.toFixed(2)}`}
LATEST EQUITY: ${equitySnapshot ? `$${equitySnapshot.equity_usd.toFixed(2)} (${equitySnapshot.ts})` : "no snapshot yet"}
BUYS FROZEN TODAY: ${daily.buys_frozen === 1 ? "YES (daily stop already hit)" : "no"}

OPEN POSITIONS:
${posLines}

LAST PLAN AND OUTCOME:
${yesterdayPlan}

RECENT REALIZED TRADES:
${realizedLines}

RECENT JOURNAL:
${journal || "empty"}

CURRENT STRATEGY (strategy.md, you wrote this in past weekly reviews):
${readStrategy().slice(0, 4000)}

Produce today's plan. Date must be ${date}.`;

  return { date, contextBlock };
}

function namespaceRuleId(date: string, id: string): string {
  return `${date}:${id}`;
}

export function persistPlan(db: Db, plan: Plan, kind: "premarket" | "midday", journalText: string): number {
  const planId = db.insertPlan(plan.date, kind, plan.thesis, JSON.stringify(plan));
  // Re-running the planner supersedes previous entry rules for the day.
  db.cancelActiveEntryRulesForDate(plan.date);
  for (const r of plan.rules) {
    db.insertRule({
      id: namespaceRuleId(plan.date, r.id),
      planId,
      date: plan.date,
      ticker: r.ticker,
      action: "buy",
      kind: "entry",
      triggerJson: JSON.stringify(r.trigger),
      amountUsd: r.amountUsd,
      validUntil: r.validUntil,
      stopLossJson: JSON.stringify(r.stopLoss),
      takeProfitJson: r.takeProfit ? JSON.stringify(r.takeProfit) : null,
      reason: r.reason ?? "",
    });
  }
  for (const r of plan.exits) {
    db.insertRule({
      id: namespaceRuleId(plan.date, r.id),
      planId,
      date: plan.date,
      ticker: r.ticker,
      action: "sell",
      kind: "exit",
      triggerJson: JSON.stringify(r.trigger),
      amountUsd: r.amountUsd ?? null,
      validUntil: r.validUntil,
      stopLossJson: null,
      takeProfitJson: null,
      reason: r.reason ?? "",
    });
  }
  db.addJournal(plan.date, kind === "premarket" ? "plan" : "midday", journalText || plan.thesis);
  return planId;
}

function describeZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// Weekly deep plan (Opus, full web search) once a week; cheaper daily runs the
// rest of the week. The very first plan ever is always deep so the experiment
// starts on a well-researched footing.
export function plannerPlanForToday(db: Db, now: Date = new Date()): { deep: boolean; model: string; maxSearches: number } {
  const firstEver = !db.hasAnyPlan();
  const deep = firstEver || !config.weeklyDeepPlan || etParts(now).weekday === config.deepPlanWeekday;
  return {
    deep,
    model: deep ? config.plannerModel : config.dailyModel,
    maxSearches: deep ? config.deepMaxWebSearches : config.plannerMaxWebSearches,
  };
}

export async function runPlanner(db: Db = getDb(), broker: Broker = createBroker()): Promise<{ ok: boolean; plan?: Plan }> {
  const { date, contextBlock } = await buildPlannerContext(db, broker);
  const today = plannerPlanForToday(db);
  log.info("planner starting", { date, model: today.model, deep: today.deep, maxSearches: today.maxSearches });

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const userMessage =
      attempt === 0
        ? contextBlock
        : `${contextBlock}\n\nYour previous output failed validation: ${lastError}\nRe-emit the journal and a CORRECTED json block. Same format.`;
    let text: string;
    try {
      const result = await callClaude({
        purpose: attempt === 0 ? (today.deep ? "planner_deep" : "planner") : "planner_retry",
        model: today.model,
        system: PLANNER_SYSTEM_PROMPT,
        userMessage,
        maxTokens: config.plannerMaxOutputTokens,
        webSearch: { maxUses: attempt === 0 ? today.maxSearches : 0 },
      });
      text = result.text;
    } catch (err) {
      lastError = String(err);
      log.error("planner API call failed", { attempt, err: lastError });
      continue;
    }

    const jsonBlock = extractJsonBlock(text);
    if (!jsonBlock) {
      lastError = "no JSON block found in output";
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(jsonBlock);
      // Force today's date: the model occasionally echoes an example date.
      if (typeof parsed === "object" && parsed !== null) (parsed as Record<string, unknown>).date = date;
      const plan = PlanSchema.parse(parsed);
      const fenceIdx = text.indexOf("```");
      const cutIdx = fenceIdx >= 0 ? fenceIdx : text.indexOf(jsonBlock);
      const journalText = (cutIdx > 0 ? text.slice(0, cutIdx) : "").trim() || plan.thesis;
      persistPlan(db, plan, "premarket", journalText);
      const rulesSummary = plan.rules.map((r) => `BUY ${r.ticker} $${r.amountUsd} on ${r.trigger.type}${"value" in r.trigger ? ` ${r.trigger.value}` : ""}`).join(" | ") || "no entries (no-trade day)";
      const exitsSummary = plan.exits.map((r) => `SELL ${r.ticker} on ${r.trigger.type}${"value" in r.trigger ? ` ${r.trigger.value}` : ""}`).join(" | ") || "none";
      await notify("plan_published", `Plan ${date}`, `${plan.thesis}\nEntradas: ${rulesSummary}\nExits: ${exitsSummary}`, { date });
      return { ok: true, plan };
    } catch (err) {
      lastError = err instanceof ZodError ? describeZodError(err) : String(err);
      log.warn("plan validation failed", { attempt, err: lastError });
    }
  }

  // Both attempts failed: protective exits on positions keep working without a plan.
  db.insertPlan(date, "fallback", "planner failed - protective exits only", "{}", "failed");
  db.addJournal(date, "event", `Planner failed twice (${lastError}). Running with protective exits only.`);
  await notify("planner_failed", "Planner failed", `No valid plan for ${date}. Day runs with position protective exits only. Last error: ${lastError.slice(0, 300)}`);
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Mid-day light revision: can only cancel existing rules and add exits.
// ---------------------------------------------------------------------------

const MIDDAY_SYSTEM_PROMPT = `You are the mid-day reviewer of an autonomous trading system (Wallbit, US stocks). It is ~12:30 ET. You may ONLY: cancel existing pending rules (by id) and add NEW exit rules on existing positions. You cannot open new theses or add buys.

Output format: a one-paragraph journal note in Spanish, then exactly one JSON block:
\`\`\`json
{"comment":"nota corta","cancelRuleIds":["full-rule-id"],"newExits":[{"id":"midday-exit-1","ticker":"XYZ","action":"sell","trigger":{"type":"price_below","value":10},"validUntil":"YYYY-MM-DDT16:00:00-04:00","reason":"..."}]}
\`\`\`
Trigger vocabulary: price_below, price_above, pct_change_intraday_below, pct_change_intraday_above, time_at ("HH:MM" ET). If nothing needs changing, return empty arrays. Keep it short.`;

export async function runMidday(db: Db = getDb(), broker: Broker = createBroker()): Promise<void> {
  const date = todayET();
  const plan = db.latestPlan(date);
  if (!plan) {
    log.info("midday: no active plan today, skipping");
    return;
  }
  const activeRules = db.activeRules().filter((r) => r.date === date);
  const positions = db.allPositions();
  const quotes = await getQuotes([...new Set([...activeRules.map((r) => r.ticker), ...positions.map((p) => p.ticker)])]);

  const ctx = `TODAY ${date}, mid-day check.
THESIS: ${plan.thesis}
PENDING RULES:
${activeRules.map((r) => `${r.id} | ${r.action.toUpperCase()} ${r.ticker} | trigger ${r.trigger_json} | now $${quotes.get(r.ticker)?.price?.toFixed(2) ?? "?"} (prev close pct ${pct(quotes.get(r.ticker))})`).join("\n") || "none"}
POSITIONS:
${positions.map((p) => `${p.ticker} ${p.shares.toFixed(4)} sh avg $${p.avg_cost.toFixed(2)} now $${quotes.get(p.ticker)?.price?.toFixed(2) ?? "?"} stop ${p.stop_loss_json ?? "none"} tp ${p.take_profit_json ?? "none"}`).join("\n") || "none"}
Adjust only if something material changed.`;

  try {
    const result = await callClaude({
      purpose: "midday",
      model: config.dailyModel,
      system: MIDDAY_SYSTEM_PROMPT,
      userMessage: ctx,
      maxTokens: 1500,
      webSearch: { maxUses: 2 },
    });
    const block = extractJsonBlock(result.text);
    if (!block) return;
    const adj = MiddayAdjustmentSchema.parse(JSON.parse(block));
    for (const id of adj.cancelRuleIds) {
      const row = db.ruleById(id);
      if (row && row.date === date && row.status === "active") db.cancelRule(id);
    }
    let planId: number | null = null;
    for (const exit of adj.newExits) {
      if (planId === null) planId = db.insertPlan(date, "midday", plan.thesis, block);
      db.insertRule({
        id: namespaceRuleId(date, exit.id),
        planId,
        date,
        ticker: exit.ticker,
        action: "sell",
        kind: "exit",
        triggerJson: JSON.stringify(exit.trigger),
        amountUsd: exit.amountUsd ?? null,
        validUntil: exit.validUntil,
        stopLossJson: null,
        takeProfitJson: null,
        reason: exit.reason ?? "midday exit",
      });
    }
    if (adj.cancelRuleIds.length > 0 || adj.newExits.length > 0) {
      db.addJournal(date, "midday", adj.comment || "midday adjustment");
      await notify("midday_adjusted", "Mid-day adjustment", `Cancelled: ${adj.cancelRuleIds.length}, new exits: ${adj.newExits.length}. ${adj.comment}`);
    } else {
      log.info("midday: no changes");
    }
  } catch (err) {
    log.error("midday run failed", { err: String(err) });
  }
}

function pct(q: { price: number; prevClose: number | null } | undefined): string {
  if (!q || q.prevClose === null || q.prevClose === 0) return "?";
  return (((q.price - q.prevClose) / q.prevClose) * 100).toFixed(2) + "%";
}

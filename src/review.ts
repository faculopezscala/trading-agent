// Weekly review: the one expensive run where the system learns. Reads the
// week's journal, trades and rule outcomes, then rewrites strategy.md.

import { config } from "./config.ts";
import { getDb, type Db } from "./db.ts";
import { callClaude } from "./llm.ts";
import { log } from "./log.ts";
import { todayET, weekStartET } from "./market.ts";
import { notify } from "./notify.ts";
import { readStrategy, writeStrategy } from "./planner.ts";

const REVIEW_SYSTEM_PROMPT = `You are the weekly strategist of an autonomous trading system (Wallbit, US stocks/ETFs, ~$100-200 experimental capital, aggressive active picking, goal: beat SPY). Once a week you study what happened and rewrite the living strategy document that the daily planner reads every morning.

Be brutally honest about what worked and what did not. Identify patterns: which trigger styles filled well, which stops were too tight/loose, which theses were noise. Update watchlist and focus areas for next week. You may use web search sparingly to check next week's known catalysts (earnings, macro calendar).

OUTPUT FORMAT (strict):
1. A review summary in Spanish (max ~250 words): performance, lessons, what changes next week.
2. Exactly one fenced markdown block with the COMPLETE new strategy.md (max 600 words). It must include sections: ## Tesis macro, ## Watchlist, ## Reglas de estilo, ## Lecciones acumuladas. Write it in Spanish, tickers in English.

\`\`\`markdown
(new strategy.md content)
\`\`\``;

export async function runWeeklyReview(db: Db = getDb()): Promise<void> {
  const today = todayET();
  const weekStart = weekStartET();

  const journal = db
    .journalBetween(weekStart, today)
    .map((j) => `[${j.date} ${j.type}] ${j.content.slice(0, 350)}`)
    .join("\n");
  const trades = db
    .realizedTrades(40)
    .filter((t) => t.closed_at.slice(0, 10) >= weekStart)
    .map((t) => `${t.closed_at.slice(0, 10)} ${t.ticker}: pnl $${t.pnl_usd.toFixed(2)} (cost $${t.cost_usd.toFixed(2)}) reason: ${t.reason.slice(0, 80)}`)
    .join("\n");
  const ruleStats = db.ruleStats(weekStart).map((s) => `${s.status}: ${s.n}`).join(", ");
  const snapshots = db.dailyCloseSnapshots(6);
  const first = snapshots[snapshots.length - 1];
  const last = snapshots[0];
  const weekPnl = first && last ? last.equity_usd - first.equity_usd : 0;
  const apiCost = db.totalApiCost();

  const ctx = `WEEK ${weekStart} -> ${today}
EQUITY: start $${first?.equity_usd?.toFixed(2) ?? "?"} -> end $${last?.equity_usd?.toFixed(2) ?? "?"} (week P&L $${weekPnl.toFixed(2)})
BENCHMARK EQUITY (SPY same capital): ${last?.benchmark_equity_usd ? `$${last.benchmark_equity_usd.toFixed(2)}` : "n/a"}
RULE OUTCOMES THIS WEEK: ${ruleStats || "none"}
REALIZED TRADES:
${trades || "none"}
JOURNAL OF THE WEEK:
${journal || "empty"}
TOTAL API COST TO DATE: $${apiCost.toFixed(2)}

CURRENT strategy.md:
${readStrategy().slice(0, 5000)}

Rewrite the strategy for next week.`;

  const models = [config.reviewModel, config.reviewFallbackModel];
  for (const model of models) {
    try {
      const result = await callClaude({
        purpose: "weekly_review",
        model,
        system: REVIEW_SYSTEM_PROMPT,
        userMessage: ctx,
        maxTokens: 3000,
        webSearch: { maxUses: 3 },
      });
      const match = /```(?:markdown|md)?\s*([\s\S]*?)```/.exec(result.text);
      const summary = result.text.slice(0, result.text.indexOf("```")).trim();
      if (match?.[1]) {
        const words = match[1].trim().split(/\s+/);
        const content = words.length > 650 ? words.slice(0, 650).join(" ") : match[1].trim();
        writeStrategy(content + "\n");
        log.info("strategy.md rewritten", { words: Math.min(words.length, 650), model });
      }
      db.addJournal(today, "review", summary || "weekly review ran (no summary text)");
      await notify("weekly_review", `Review semanal ${today}`, summary.slice(0, 1500) || "review completed");
      return;
    } catch (err) {
      log.error(`weekly review failed with ${model}`, { err: String(err) });
    }
  }
  await notify("planner_failed", "Weekly review failed", "Both review models failed; strategy.md unchanged.");
}

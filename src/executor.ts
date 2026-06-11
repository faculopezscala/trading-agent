// Deterministic executor. No LLM anywhere in this path: it polls quotes,
// evaluates the rule engine, runs guardrails and submits orders. Runs every
// TICK_INTERVAL_SEC during market hours and costs zero tokens.

import { config } from "./config.ts";
import { getDb, type Db, type PositionRow, type RuleRow } from "./db.ts";
import {
  checkOrder,
  type AccountState,
  type AssetCheck,
  type GuardrailConfig,
  DEFAULT_GUARDRAILS,
  dailyStopBreached,
  killSwitchBreached,
  dayPnlPct,
} from "./guardrails.ts";
import { log } from "./log.ts";
import { etParts, isMarketOpen, todayET } from "./market.ts";
import { notify as defaultNotify, type NotifyEvent } from "./notify.ts";
import { getQuotes as defaultGetQuotes } from "./prices.ts";
import { evaluateRule, evaluateTrigger, parseTrigger, type EvalContext, type Quote, type StoredRule } from "./rules.ts";
import { createBroker, type Broker } from "./broker.ts";
import { wallbit } from "./wallbit.ts";

export interface ExecutorDeps {
  db: Db;
  broker: Broker;
  fetchQuotes: (tickers: string[]) => Promise<Map<string, Quote>>;
  notify: (event: NotifyEvent, title: string, message: string, data?: unknown) => Promise<void>;
  now: () => Date;
  marketOpen: (d: Date) => boolean;
  assetCheck: (ticker: string, quote: Quote | null) => Promise<AssetCheck>;
  guardrails: GuardrailConfig;
  benchmarkTicker: string;
  snapshotIntervalMin: number;
}

export interface TickSummary {
  skipped: string | null;
  fired: string[];
  expired: string[];
  protectiveSells: string[];
  equity: number | null;
}

const KILL_SWITCH_KEY = "kill_switch";
const INITIAL_CAPITAL_KEY = "initial_capital";
const BENCHMARK_INITIAL_KEY = "benchmark_initial_price";
const LAST_SNAPSHOT_KEY = "last_snapshot_ts";

export function initialCapital(db: Db): number {
  const stored = db.getMetaNum(INITIAL_CAPITAL_KEY);
  if (stored !== null) return stored;
  db.setMeta(INITIAL_CAPITAL_KEY, String(config.initialCapitalUsd));
  return config.initialCapitalUsd;
}

export function isKillSwitchActive(db: Db): boolean {
  return db.getMeta(KILL_SWITCH_KEY) === "1";
}

const assetCache = new Map<string, { check: AssetCheck; ts: number }>();

async function defaultAssetCheck(ticker: string, quote: Quote | null): Promise<AssetCheck> {
  const cached = assetCache.get(ticker);
  if (cached && Date.now() - cached.ts < 12 * 3600 * 1000) return cached.check;
  let check: AssetCheck;
  if (wallbit.hasKey) {
    try {
      const asset = await wallbit.getAsset(ticker);
      check = asset
        ? { inCatalog: true, price: quote?.price ?? asset.price, assetType: asset.asset_type }
        : { inCatalog: false, price: quote?.price ?? null, assetType: null };
    } catch (err) {
      log.warn("asset check failed, assuming tradable if quoted", { ticker, err: String(err) });
      check = { inCatalog: quote !== null, price: quote?.price ?? null, assetType: null };
    }
  } else {
    // Dry-run without a Wallbit key: a live quote is the best catalog proxy.
    check = { inCatalog: quote !== null, price: quote?.price ?? null, assetType: null };
  }
  assetCache.set(ticker, { check, ts: Date.now() });
  return check;
}

export function defaultDeps(): ExecutorDeps {
  return {
    db: getDb(),
    broker: createBroker(),
    fetchQuotes: defaultGetQuotes,
    notify: defaultNotify,
    now: () => new Date(),
    marketOpen: isMarketOpen,
    assetCheck: defaultAssetCheck,
    guardrails: {
      ...DEFAULT_GUARDRAILS,
      maxPositionPct: config.maxPositionPct,
      maxOrdersPerDay: config.maxOrdersPerDay,
      dailyStopPct: config.dailyStopPct,
      killSwitchEquityPct: config.killSwitchEquityPct,
      minAssetPriceUsd: config.minAssetPriceUsd,
    },
    benchmarkTicker: config.benchmarkTicker,
    snapshotIntervalMin: 5,
  };
}

export function createExecutor(deps: ExecutorDeps) {
  const { db } = deps;

  function rowToStoredRule(row: RuleRow): StoredRule | null {
    const trigger = parseTrigger(row.trigger_json);
    if (!trigger) return null;
    return {
      id: row.id,
      ticker: row.ticker,
      action: row.action,
      trigger,
      amountUsd: row.amount_usd,
      validUntil: row.valid_until,
      stopLoss: parseTrigger(row.stop_loss_json),
      takeProfit: parseTrigger(row.take_profit_json),
    };
  }

  function hasInflightOrder(ticker: string): boolean {
    return db.pendingVerificationOrders().some((o) => o.ticker === ticker);
  }

  async function applyVerifiedFills(): Promise<void> {
    if (!deps.broker.reconcile) return;
    const fills = await deps.broker.reconcile();
    for (const fill of fills) {
      const rule = fill.ruleId ? db.ruleById(fill.ruleId) : null;
      if (fill.side === "buy") {
        db.applyBuyFill({
          ticker: fill.ticker,
          shares: fill.fillShares,
          fillUsd: fill.fillUsd,
          stopLossJson: rule?.stop_loss_json ?? null,
          takeProfitJson: rule?.take_profit_json ?? null,
          sourceRuleId: fill.ruleId,
        });
        if (fill.external) {
          db.addJournal(todayET(deps.now()), "event", `Posicion externa adoptada: ${fill.ticker} ${fill.fillShares.toFixed(6)} sh (~$${fill.fillUsd.toFixed(2)}). Sin stop loss hasta que el planner la cubra.`);
        }
      } else {
        const pnl = db.applySellFill({
          ticker: fill.ticker,
          shares: fill.fillShares,
          proceedsUsd: fill.fillUsd,
          ruleId: fill.ruleId,
          reason: rule?.reason ?? (fill.external ? "external/manual" : "verified sell"),
        });
        log.info("sell fill verified", { ticker: fill.ticker, external: fill.external, pnl: pnl.toFixed(2) });
      }
      await deps.notify(
        "order_executed",
        `${fill.external ? "EXTERNO: " : ""}${fill.side.toUpperCase()} ${fill.ticker} ${fill.external ? "detectado" : "confirmado"}`,
        `${fill.fillShares.toFixed(6)} shares @ ~$${fill.fillPrice.toFixed(2)} (~$${fill.fillUsd.toFixed(2)})`,
        fill,
      );
    }
  }

  async function buildAccountState(
    positions: PositionRow[],
    quotes: Map<string, Quote>,
    date: string,
  ): Promise<{ state: Omit<AccountState, "asset">; equity: number; cash: number }> {
    const cash = await deps.broker.getCash();
    const positionStates = positions.map((p) => {
      const quote = quotes.get(p.ticker);
      return {
        ticker: p.ticker,
        shares: p.shares,
        costBasis: p.cost_basis,
        marketValue: p.shares * (quote?.price ?? p.avg_cost),
      };
    });
    const equity = cash + positionStates.reduce((acc, p) => acc + p.marketValue, 0);
    const daily = db.getDailyState(date);
    return {
      state: {
        initialCapital: initialCapital(db),
        equity,
        cash,
        dayStartEquity: daily.day_start_equity,
        ordersToday: daily.orders_count,
        buysFrozen: daily.buys_frozen === 1,
        killSwitchActive: isKillSwitchActive(db),
        positions: positionStates,
      },
      equity,
      cash,
    };
  }

  function maybeSnapshot(date: string, equity: number, cash: number, positions: PositionRow[], quotes: Map<string, Quote>, dayPnl: number | null) {
    const last = db.getMetaNum(LAST_SNAPSHOT_KEY) ?? 0;
    if (Date.now() - last < deps.snapshotIntervalMin * 60 * 1000) return;
    const benchmarkQuote = quotes.get(deps.benchmarkTicker) ?? null;
    let benchmarkEquity: number | null = null;
    if (benchmarkQuote) {
      let initialPrice = db.getMetaNum(BENCHMARK_INITIAL_KEY);
      if (initialPrice === null) {
        initialPrice = benchmarkQuote.price;
        db.setMeta(BENCHMARK_INITIAL_KEY, String(initialPrice));
      }
      benchmarkEquity = initialCapital(db) * (benchmarkQuote.price / initialPrice);
    }
    const positionsJson = JSON.stringify(
      positions.map((p) => ({
        ticker: p.ticker,
        shares: p.shares,
        avgCost: p.avg_cost,
        price: quotes.get(p.ticker)?.price ?? null,
        value: p.shares * (quotes.get(p.ticker)?.price ?? p.avg_cost),
      })),
    );
    db.addSnapshot({
      date,
      equityUsd: equity,
      cashUsd: cash,
      investedUsd: equity - cash,
      positionsJson,
      benchmarkPrice: benchmarkQuote?.price ?? null,
      benchmarkEquityUsd: benchmarkEquity,
      dayPnlPct: dayPnl,
    });
    db.setMeta(LAST_SNAPSHOT_KEY, String(Date.now()));
  }

  async function executeBuy(rule: StoredRule, reason: string, quote: Quote, base: Omit<AccountState, "asset">, date: string): Promise<boolean> {
    const asset = await deps.assetCheck(rule.ticker, quote);
    const verdict = checkOrder(
      { ticker: rule.ticker, side: "buy", amountUsd: rule.amountUsd, shares: null, hasStopLoss: rule.stopLoss !== null },
      { ...base, asset },
      deps.guardrails,
    );
    if (!verdict.ok) {
      db.setRuleStatus(rule.id, "cancelled");
      db.addJournal(date, "event", `Rule ${rule.id} (BUY ${rule.ticker}) rejected by guardrail [${verdict.code}]: ${verdict.reason}`);
      log.warn("buy rejected by guardrail", { rule: rule.id, code: verdict.code, reason: verdict.reason });
      return false;
    }
    const result = await deps.broker.submitBuy(rule.ticker, rule.amountUsd!, quote, rule.id);
    db.incrementOrdersCount(date);
    if (!result.ok) {
      db.addJournal(date, "event", `BUY ${rule.ticker} $${rule.amountUsd} failed: ${result.error}`);
      await deps.notify("order_failed", `BUY ${rule.ticker} failed`, result.error ?? "unknown error", { rule: rule.id });
      return false;
    }
    if (result.immediateFill) {
      const ruleRow = db.ruleById(rule.id);
      db.applyBuyFill({
        ticker: rule.ticker,
        shares: result.immediateFill.shares,
        fillUsd: result.immediateFill.usd,
        stopLossJson: ruleRow?.stop_loss_json ?? null,
        takeProfitJson: ruleRow?.take_profit_json ?? null,
        sourceRuleId: rule.id,
      });
    }
    // In notify mode the broker already sent the manual-execution signal.
    if (deps.broker.mode !== "notify") {
      const mode = deps.broker.mode === "dry" ? "[DRY-RUN] " : "";
      await deps.notify(
        "order_executed",
        `${mode}BUY ${rule.ticker} $${rule.amountUsd}`,
        `Rule ${rule.id} fired: ${reason}. Price ~$${quote.price.toFixed(2)}.`,
        { rule: rule.id, mode: deps.broker.mode },
      );
    }
    return true;
  }

  async function executeSell(opts: {
    ticker: string;
    shares: number;
    ruleId: string | null;
    reason: string;
    quote: Quote;
    date: string;
    base: Omit<AccountState, "asset">;
  }): Promise<boolean> {
    const verdict = checkOrder(
      { ticker: opts.ticker, side: "sell", amountUsd: null, shares: opts.shares, hasStopLoss: true },
      { ...opts.base, asset: null },
      deps.guardrails,
    );
    if (!verdict.ok) {
      log.warn("sell rejected by guardrail", { ticker: opts.ticker, code: verdict.code });
      return false;
    }
    const result = await deps.broker.submitSell(opts.ticker, opts.shares, opts.quote, opts.ruleId, opts.reason);
    db.incrementOrdersCount(opts.date);
    if (!result.ok) {
      await deps.notify("order_failed", `SELL ${opts.ticker} failed`, result.error ?? "unknown error", { rule: opts.ruleId });
      return false;
    }
    let pnlNote = "";
    if (result.immediateFill) {
      const pnl = db.applySellFill({
        ticker: opts.ticker,
        shares: result.immediateFill.shares,
        proceedsUsd: result.immediateFill.usd,
        ruleId: opts.ruleId,
        reason: opts.reason,
      });
      pnlNote = ` Realized P&L: $${pnl.toFixed(2)}.`;
    }
    if (deps.broker.mode !== "notify") {
      const mode = deps.broker.mode === "dry" ? "[DRY-RUN] " : "";
      await deps.notify(
        "order_executed",
        `${mode}SELL ${opts.ticker}`,
        `${opts.reason}. ~${opts.shares.toFixed(6)} shares @ ~$${opts.quote.price.toFixed(2)}.${pnlNote}`,
        { rule: opts.ruleId, mode: deps.broker.mode },
      );
    }
    return true;
  }

  async function tick(): Promise<TickSummary> {
    const summary: TickSummary = { skipped: null, fired: [], expired: [], protectiveSells: [], equity: null };
    db.setHeartbeat();
    const now = deps.now();

    if (!deps.marketOpen(now)) {
      summary.skipped = "market_closed";
      return summary;
    }
    const date = todayET(now);
    const nowEt = etParts(now);

    await applyVerifiedFills();

    const ruleRows = db.activeRules();
    const positions = db.allPositions();
    const tickers = new Set<string>([deps.benchmarkTicker]);
    for (const r of ruleRows) tickers.add(r.ticker);
    for (const p of positions) tickers.add(p.ticker);
    const quotes = await deps.fetchQuotes([...tickers]);

    const { state: base, equity, cash } = await buildAccountState(positions, quotes, date);
    summary.equity = equity;

    const daily = db.getDailyState(date);
    const marketJustOpened = daily.day_start_equity === null;
    if (marketJustOpened) {
      db.setDailyState(date, { day_start_equity: equity });
      base.dayStartEquity = equity;
    }

    // Kill switch: freeze everything, read-only until manual unfreeze.
    if (isKillSwitchActive(db)) {
      summary.skipped = "kill_switch";
      maybeSnapshot(date, equity, cash, positions, quotes, dayPnlPct(base));
      return summary;
    }
    if (killSwitchBreached(base, deps.guardrails)) {
      db.setMeta(KILL_SWITCH_KEY, "1");
      await deps.notify(
        "kill_switch",
        "KILL SWITCH ACTIVATED",
        `Equity $${equity.toFixed(2)} fell below ${deps.guardrails.killSwitchEquityPct * 100}% of initial capital $${base.initialCapital}. All trading frozen. Run 'bun run unfreeze' after manual review.`,
      );
      summary.skipped = "kill_switch";
      return summary;
    }

    // Daily stop: freeze buys for the rest of the day, exits stay active.
    if (!base.buysFrozen && dailyStopBreached(base, deps.guardrails)) {
      db.setDailyState(date, { buys_frozen: 1 });
      base.buysFrozen = true;
      await deps.notify(
        "daily_stop",
        "Daily stop hit",
        `Day P&L ${((dayPnlPct(base) ?? 0) * 100).toFixed(2)}% breached ${deps.guardrails.dailyStopPct * 100}%. Buys frozen until tomorrow, exits remain active.`,
      );
    }

    maybeSnapshot(date, equity, cash, positions, quotes, dayPnlPct(base));

    const ctxFor = (ticker: string): EvalContext => ({
      quote: quotes.get(ticker) ?? null,
      nowEt,
      now,
      marketJustOpened,
    });

    // 1) Protective exits on open positions ALWAYS run, even when the
    //    planner failed and no plan exists for today.
    for (const pos of positions) {
      if (hasInflightOrder(pos.ticker)) continue;
      const quote = quotes.get(pos.ticker);
      if (!quote) continue;
      const ctx = ctxFor(pos.ticker);
      const stop = parseTrigger(pos.stop_loss_json);
      const take = parseTrigger(pos.take_profit_json);
      let sellReason: string | null = null;
      if (stop && evaluateTrigger(stop, ctx).fire) sellReason = `stop_loss ${JSON.stringify(stop)}`;
      else if (take && evaluateTrigger(take, ctx).fire) sellReason = `take_profit ${JSON.stringify(take)}`;
      if (sellReason) {
        const ok = await executeSell({ ticker: pos.ticker, shares: pos.shares, ruleId: pos.source_rule_id, reason: sellReason, quote, date, base });
        if (ok) {
          summary.protectiveSells.push(pos.ticker);
          base.positions = base.positions.filter((p) => p.ticker !== pos.ticker);
        }
      }
    }

    // 2) Plan rules.
    for (const row of ruleRows) {
      const rule = rowToStoredRule(row);
      if (!rule) {
        db.setRuleStatus(row.id, "cancelled");
        log.warn("rule with unparseable trigger cancelled", { id: row.id });
        continue;
      }
      const decision = evaluateRule(rule, ctxFor(rule.ticker));
      if (decision.kind === "expired") {
        db.expireRule(rule.id);
        summary.expired.push(rule.id);
        continue;
      }
      if (decision.kind !== "fire") continue;
      if (rule.action === "buy" && base.buysFrozen) continue; // stays active; guardrail would reject anyway
      if (hasInflightOrder(rule.ticker)) continue;
      const quote = quotes.get(rule.ticker);
      if (!quote) continue;

      if (!db.claimRule(rule.id)) continue; // idempotency: someone already executed it

      if (rule.action === "buy") {
        const ok = await executeBuy(rule, decision.reason, quote, base, date);
        if (ok) {
          summary.fired.push(rule.id);
          const daily2 = db.getDailyState(date);
          base.ordersToday = daily2.orders_count;
          base.cash = cash - (rule.amountUsd ?? 0);
        }
      } else {
        const pos = db.getPosition(rule.ticker);
        if (!pos) {
          db.setRuleStatus(rule.id, "cancelled");
          db.addJournal(date, "event", `Exit rule ${rule.id} cancelled: no open position in ${rule.ticker}`);
          continue;
        }
        const shares = rule.amountUsd ? Math.min(pos.shares, rule.amountUsd / quote.price) : pos.shares;
        const ok = await executeSell({ ticker: rule.ticker, shares, ruleId: rule.id, reason: row.reason || `exit rule ${rule.id}`, quote, date, base });
        if (ok) summary.fired.push(rule.id);
        else db.setRuleStatus(rule.id, "cancelled");
      }
    }

    return summary;
  }

  return { tick };
}

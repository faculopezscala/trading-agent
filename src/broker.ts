// Broker abstraction. Three modes share the whole pipeline, only the last
// step changes:
// - PaperBroker (dry_run): simulates fills locally.
// - NotifyBroker (notify): emits an exact signal for manual execution in the
//   Wallbit app (free plan: read-only API) and detects the real fill by
//   polling the portfolio. Re-notifies once at 15min, marks missed at 30min.
// - LiveBroker (live): submits MARKET orders via API (requires Wallbit Pro)
//   and verifies fills against the real portfolio. Never assumes execution.

import { config } from "./config.ts";
import { getDb, type Db } from "./db.ts";
import { log } from "./log.ts";
import { notify, type NotifyEvent } from "./notify.ts";
import { getQuote } from "./prices.ts";
import { describeTrigger, parseTrigger, type Quote } from "./rules.ts";
import { wallbit, WallbitError, type WallbitClient } from "./wallbit.ts";

export interface SubmitResult {
  ok: boolean;
  orderId: number;
  immediateFill: { price: number; shares: number; usd: number } | null;
  error?: string;
}

// A fill confirmed against the real account (or an external manual trade
// detected in it). The executor applies these to the position book.
export interface ReconciledFill {
  orderId: number | null;
  ruleId: string | null;
  ticker: string;
  side: "buy" | "sell";
  fillPrice: number;
  fillShares: number;
  fillUsd: number;
  external: boolean;
}

export interface Broker {
  mode: "live" | "dry" | "notify";
  getCash(): Promise<number>;
  // amountUsd buys, shares sells. quote = best known current price.
  submitBuy(ticker: string, amountUsd: number, quote: Quote, ruleId: string | null): Promise<SubmitResult>;
  submitSell(ticker: string, shares: number, quote: Quote, ruleId: string | null, reason: string): Promise<SubmitResult>;
  // Confirms pending orders against the real account. Absent on PaperBroker.
  reconcile?(): Promise<ReconciledFill[]>;
}

const PAPER_CASH_KEY = "paper_cash";

export class PaperBroker implements Broker {
  mode = "dry" as const;

  constructor(private db: Db = getDb()) {}

  async getCash(): Promise<number> {
    const cash = this.db.getMetaNum(PAPER_CASH_KEY);
    if (cash === null) {
      this.db.setMeta(PAPER_CASH_KEY, String(config.initialCapitalUsd));
      return config.initialCapitalUsd;
    }
    return cash;
  }

  async submitBuy(ticker: string, amountUsd: number, quote: Quote, ruleId: string | null): Promise<SubmitResult> {
    const cash = await this.getCash();
    if (amountUsd > cash + 0.01) {
      const orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "buy",
        reqAmountUsd: amountUsd,
        reqShares: null,
        mode: "dry",
        status: "failed",
        error: "insufficient paper cash",
      });
      return { ok: false, orderId, immediateFill: null, error: "insufficient paper cash" };
    }
    const shares = amountUsd / quote.price;
    this.db.setMeta(PAPER_CASH_KEY, String(cash - amountUsd));
    const orderId = this.db.insertOrder({
      ruleId,
      ticker,
      side: "buy",
      reqAmountUsd: amountUsd,
      reqShares: null,
      mode: "dry",
      status: "filled",
      fillPrice: quote.price,
      fillShares: shares,
      fillUsd: amountUsd,
    });
    this.db.updateOrder(orderId, { verified_at: new Date().toISOString() });
    return { ok: true, orderId, immediateFill: { price: quote.price, shares, usd: amountUsd } };
  }

  async submitSell(ticker: string, shares: number, quote: Quote, ruleId: string | null, _reason: string): Promise<SubmitResult> {
    const proceeds = shares * quote.price;
    const cash = await this.getCash();
    this.db.setMeta(PAPER_CASH_KEY, String(cash + proceeds));
    const orderId = this.db.insertOrder({
      ruleId,
      ticker,
      side: "sell",
      reqAmountUsd: null,
      reqShares: shares,
      mode: "dry",
      status: "filled",
      fillPrice: quote.price,
      fillShares: shares,
      fillUsd: proceeds,
    });
    this.db.updateOrder(orderId, { verified_at: new Date().toISOString() });
    return { ok: true, orderId, immediateFill: { price: quote.price, shares, usd: proceeds } };
  }
}

export class LiveBroker implements Broker {
  mode = "live" as const;

  constructor(
    private db: Db = getDb(),
    private client: WallbitClient = wallbit,
  ) {}

  async getCash(): Promise<number> {
    const holdings = await this.client.getStocksBalance();
    return holdings.find((h) => h.symbol === "USD")?.shares ?? 0;
  }

  private async sharesOf(ticker: string): Promise<number> {
    const holdings = await this.client.getStocksBalance();
    return holdings.find((h) => h.symbol === ticker)?.shares ?? 0;
  }

  async submitBuy(ticker: string, amountUsd: number, quote: Quote, ruleId: string | null): Promise<SubmitResult> {
    const preShares = await this.sharesOf(ticker);
    let orderId = -1;
    try {
      const trade = await this.client.createTrade({
        symbol: ticker,
        direction: "BUY",
        currency: "USD",
        order_type: "MARKET",
        amount: round2(amountUsd),
      });
      orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "buy",
        reqAmountUsd: amountUsd,
        reqShares: null,
        mode: "live",
        status: "submitted",
        wallbitJson: JSON.stringify({ trade, preShares, quotePrice: quote.price }),
      });
      return { ok: true, orderId, immediateFill: null };
    } catch (err) {
      const msg = err instanceof WallbitError ? `${err.status}: ${err.message}` : String(err);
      orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "buy",
        reqAmountUsd: amountUsd,
        reqShares: null,
        mode: "live",
        status: "failed",
        error: msg,
      });
      return { ok: false, orderId, immediateFill: null, error: msg };
    }
  }

  async submitSell(ticker: string, shares: number, quote: Quote, ruleId: string | null, _reason: string): Promise<SubmitResult> {
    const preShares = await this.sharesOf(ticker);
    const sellShares = Math.min(shares, preShares);
    if (sellShares <= 0) {
      const orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "sell",
        reqAmountUsd: null,
        reqShares: shares,
        mode: "live",
        status: "failed",
        error: "no shares held at broker",
      });
      return { ok: false, orderId, immediateFill: null, error: "no shares held at broker" };
    }
    try {
      const trade = await this.client.createTrade({
        symbol: ticker,
        direction: "SELL",
        currency: "USD",
        order_type: "MARKET",
        shares: sellShares,
      });
      const orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "sell",
        reqAmountUsd: null,
        reqShares: sellShares,
        mode: "live",
        status: "submitted",
        wallbitJson: JSON.stringify({ trade, preShares, quotePrice: quote.price }),
      });
      return { ok: true, orderId, immediateFill: null };
    } catch (err) {
      const msg = err instanceof WallbitError ? `${err.status}: ${err.message}` : String(err);
      const orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "sell",
        reqAmountUsd: null,
        reqShares: sellShares,
        mode: "live",
        status: "failed",
        error: msg,
      });
      return { ok: false, orderId, immediateFill: null, error: msg };
    }
  }

  async reconcile(): Promise<ReconciledFill[]> {
    return this.verifyPending();
  }

  // Called every tick: compares current holdings against the pre-trade
  // snapshot stored with each submitted order. Marks fills once the share
  // delta shows up; flags orders unverified after 15 minutes.
  async verifyPending(): Promise<ReconciledFill[]> {
    const pending = this.db.pendingVerificationOrders().filter((o) => o.mode === "live");
    if (pending.length === 0) return [];
    const fills: ReconciledFill[] = [];
    let holdings: { symbol: string; shares: number }[];
    try {
      holdings = await this.client.getStocksBalance();
    } catch (err) {
      log.warn("verifyPending: balance fetch failed", { err: String(err) });
      return [];
    }
    for (const order of pending) {
      const meta = safeParse(order.wallbit_json) as { preShares?: number; quotePrice?: number } | null;
      const preShares = meta?.preShares ?? 0;
      const quotePrice = meta?.quotePrice ?? 0;
      const nowShares = holdings.find((h) => h.symbol === order.ticker)?.shares ?? 0;
      const delta = order.side === "buy" ? nowShares - preShares : preShares - nowShares;
      if (delta > 1e-9) {
        const fillShares = delta;
        const fillUsd = order.side === "buy" ? (order.req_amount_usd ?? quotePrice * fillShares) : quotePrice * fillShares;
        const fillPrice = fillShares > 0 ? fillUsd / fillShares : quotePrice;
        this.db.updateOrder(order.id, {
          status: "filled",
          fill_price: fillPrice,
          fill_shares: fillShares,
          fill_usd: fillUsd,
          verified_at: new Date().toISOString(),
        });
        fills.push({ orderId: order.id, ticker: order.ticker, side: order.side, fillPrice, fillShares, fillUsd, ruleId: order.rule_id, external: false });
      } else {
        const ageMin = orderAgeMin(order.requested_at);
        if (ageMin > 15) {
          this.db.updateOrder(order.id, { status: "unverified", error: "fill not observed within 15min" });
          log.warn("order unverified after 15min", { orderId: order.id, ticker: order.ticker });
        }
      }
    }
    return fills;
  }
}

// Signal-driven manual execution: the system decides, the human places the
// order in the Wallbit app, the system verifies the real fill via the
// read-only API. Exists because API trading requires the paid Pro plan.
export class NotifyBroker implements Broker {
  mode = "notify" as const;

  constructor(
    private db: Db = getDb(),
    private client: WallbitClient = wallbit,
    private send: (event: NotifyEvent, title: string, message: string, data?: unknown) => Promise<void> = notify,
    private quoteFn: (ticker: string) => Promise<Quote | null> = getQuote,
  ) {}

  async getCash(): Promise<number> {
    const holdings = await this.client.getStocksBalance();
    return holdings.find((h) => h.symbol === "USD")?.shares ?? 0;
  }

  private async sharesOf(ticker: string): Promise<number> {
    const holdings = await this.client.getStocksBalance();
    return holdings.find((h) => h.symbol === ticker)?.shares ?? 0;
  }

  private buySignalText(ticker: string, amountUsd: number, quote: Quote, ruleId: string | null, reminder: boolean): { title: string; message: string } {
    const rule = ruleId ? this.db.ruleById(ruleId) : null;
    const sl = describeTrigger(parseTrigger(rule?.stop_loss_json ?? null));
    const tp = rule?.take_profit_json ? describeTrigger(parseTrigger(rule.take_profit_json)) : null;
    const prefix = reminder ? "RECORDATORIO (2/2): " : "";
    return {
      title: `${prefix}SEÑAL: COMPRAR ${ticker} $${amountUsd.toFixed(0)}`,
      message:
        `Comprar $${amountUsd.toFixed(2)} de ${ticker} a ~$${quote.price.toFixed(2)} (orden MARKET en la app).\n` +
        `Cargar en la app como ordenes nativas: stop loss ${sl}${tp ? `, take profit ${tp}` : ""}.\n` +
        (rule?.reason ? `Razon: ${rule.reason}\n` : "") +
        `La señal expira en 30 min si no se detecta el fill.`,
    };
  }

  private sellSignalText(ticker: string, shares: number, quote: Quote, reason: string, reminder: boolean): { title: string; message: string } {
    const prefix = reminder ? "RECORDATORIO (2/2): " : "";
    return {
      title: `${prefix}SEÑAL: VENDER ${ticker}`,
      message:
        `Vender ${shares.toFixed(6)} shares de ${ticker} (~$${(shares * quote.price).toFixed(2)} a ~$${quote.price.toFixed(2)}).\n` +
        `Razon: ${reason}\n` +
        `La señal expira en 30 min si no se detecta el fill.`,
    };
  }

  async submitBuy(ticker: string, amountUsd: number, quote: Quote, ruleId: string | null): Promise<SubmitResult> {
    let preShares = 0;
    try {
      preShares = await this.sharesOf(ticker);
    } catch (err) {
      log.warn("notify submitBuy: balance fetch failed, preShares=0", { err: String(err) });
    }
    const orderId = this.db.insertOrder({
      ruleId,
      ticker,
      side: "buy",
      reqAmountUsd: amountUsd,
      reqShares: null,
      mode: "notify",
      status: "awaiting_manual",
      wallbitJson: JSON.stringify({ preShares, quotePrice: quote.price }),
    });
    const { title, message } = this.buySignalText(ticker, amountUsd, quote, ruleId, false);
    await this.send("order_signal", title, message, { orderId, ruleId });
    return { ok: true, orderId, immediateFill: null };
  }

  async submitSell(ticker: string, shares: number, quote: Quote, ruleId: string | null, reason: string): Promise<SubmitResult> {
    let preShares = shares;
    try {
      preShares = await this.sharesOf(ticker);
    } catch (err) {
      log.warn("notify submitSell: balance fetch failed, using db shares", { err: String(err) });
    }
    const sellShares = Math.min(shares, preShares);
    if (sellShares <= 0) {
      const orderId = this.db.insertOrder({
        ruleId,
        ticker,
        side: "sell",
        reqAmountUsd: null,
        reqShares: shares,
        mode: "notify",
        status: "failed",
        error: "no shares held at broker",
      });
      return { ok: false, orderId, immediateFill: null, error: "no shares held at broker" };
    }
    const orderId = this.db.insertOrder({
      ruleId,
      ticker,
      side: "sell",
      reqAmountUsd: null,
      reqShares: sellShares,
      mode: "notify",
      status: "awaiting_manual",
      wallbitJson: JSON.stringify({ preShares, quotePrice: quote.price, reason }),
    });
    const { title, message } = this.sellSignalText(ticker, sellShares, quote, reason, false);
    await this.send("order_signal", title, message, { orderId, ruleId });
    return { ok: true, orderId, immediateFill: null };
  }

  // Each tick: detect manual fills by share delta, re-notify once at 15min,
  // mark missed at 30min, and adopt external trades made directly in the app
  // (e.g. native stop orders executing) so the book always matches reality.
  async reconcile(): Promise<ReconciledFill[]> {
    let holdings: { symbol: string; shares: number }[];
    try {
      holdings = await this.client.getStocksBalance();
    } catch (err) {
      log.warn("notify reconcile: balance fetch failed", { err: String(err) });
      return [];
    }
    const sharesAt = (ticker: string) => holdings.find((h) => h.symbol === ticker)?.shares ?? 0;
    const fills: ReconciledFill[] = [];
    // Tickers already accounted for in this pass: pending signals plus fills
    // just detected (their DB position updates after we return, so the
    // external-diff loops below must not double-count them).
    const touched = new Set<string>();

    const pending = this.db.pendingVerificationOrders().filter((o) => o.mode === "notify");
    for (const order of pending) {
      const meta = (safeParse(order.wallbit_json) ?? {}) as { preShares?: number; quotePrice?: number; reason?: string; renotified?: boolean };
      const preShares = meta.preShares ?? 0;
      const quotePrice = meta.quotePrice ?? 0;
      const nowShares = sharesAt(order.ticker);
      const delta = order.side === "buy" ? nowShares - preShares : preShares - nowShares;
      touched.add(order.ticker);

      if (delta > 1e-9) {
        const fillShares = delta;
        const fillUsd = quotePrice > 0 ? fillShares * quotePrice : (order.req_amount_usd ?? 0);
        const fillPrice = fillShares > 0 && fillUsd > 0 ? fillUsd / fillShares : quotePrice;
        this.db.updateOrder(order.id, {
          status: "filled",
          fill_price: fillPrice,
          fill_shares: fillShares,
          fill_usd: fillUsd,
          verified_at: new Date().toISOString(),
        });
        fills.push({ orderId: order.id, ticker: order.ticker, side: order.side, fillPrice, fillShares, fillUsd, ruleId: order.rule_id, external: false });
        continue;
      }

      const ageMin = orderAgeMin(order.requested_at);
      if (ageMin >= 30) {
        this.db.updateOrder(order.id, { status: "missed", error: "manual execution not detected within 30min" });
        // Mark the rule missed only when the order is the rule's own action.
        // Protective sells carry the originating BUY rule id: that one already
        // executed and must keep its status (the exit will re-signal anyway).
        if (order.rule_id) {
          const rule = this.db.ruleById(order.rule_id);
          if (rule && rule.action === order.side) this.db.setRuleStatus(order.rule_id, "missed");
        }
        await this.send(
          "order_missed",
          `Señal perdida: ${order.side.toUpperCase()} ${order.ticker}`,
          `No se detecto el fill manual en 30 min. ${order.rule_id ? `Regla ${order.rule_id} marcada como missed.` : ""}`,
          { orderId: order.id },
        );
      } else if (ageMin >= 15 && !meta.renotified) {
        this.db.updateOrder(order.id, { wallbit_json: JSON.stringify({ ...meta, renotified: true }) });
        const quote: Quote = { ticker: order.ticker, price: quotePrice, prevClose: null, dayOpen: null, ts: Date.now(), source: "signal" };
        const { title, message } =
          order.side === "buy"
            ? this.buySignalText(order.ticker, order.req_amount_usd ?? 0, quote, order.rule_id, true)
            : this.sellSignalText(order.ticker, order.req_shares ?? 0, quote, meta.reason ?? "exit", true);
        await this.send("order_signal", title, message, { orderId: order.id, reminder: true });
      }
    }

    // External changes: trades done directly in the app without a signal.
    for (const pos of this.db.allPositions()) {
      if (touched.has(pos.ticker)) continue;
      const diff = sharesAt(pos.ticker) - pos.shares;
      if (Math.abs(diff) <= 1e-6) continue;
      const quote = await this.quoteFn(pos.ticker);
      const price = quote?.price ?? pos.avg_cost;
      if (diff < 0) {
        fills.push({ orderId: null, ruleId: null, ticker: pos.ticker, side: "sell", fillPrice: price, fillShares: -diff, fillUsd: -diff * price, external: true });
      } else {
        fills.push({ orderId: null, ruleId: null, ticker: pos.ticker, side: "buy", fillPrice: price, fillShares: diff, fillUsd: diff * price, external: true });
      }
    }
    for (const h of holdings) {
      if (h.symbol === "USD" || h.shares <= 1e-6) continue;
      if (this.db.getPosition(h.symbol) || touched.has(h.symbol)) continue;
      const quote = await this.quoteFn(h.symbol);
      const price = quote?.price ?? 0;
      fills.push({ orderId: null, ruleId: null, ticker: h.symbol, side: "buy", fillPrice: price, fillShares: h.shares, fillUsd: h.shares * price, external: true });
    }
    return fills;
  }
}

function orderAgeMin(requestedAt: string): number {
  return (Date.now() - Date.parse(requestedAt + (requestedAt.endsWith("Z") ? "" : "Z"))) / 60000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function createBroker(): Broker {
  switch (config.executionMode) {
    case "live":
      return new LiveBroker();
    case "notify":
      return new NotifyBroker();
    default:
      return new PaperBroker();
  }
}

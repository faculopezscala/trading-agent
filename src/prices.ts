// Price feed for the executor.
//
// Decision (documented for the operator):
// - Primary: Yahoo Finance chart API (query1.finance.yahoo.com/v8/finance/chart).
//   Free, no API key, per-symbol requests, gives last price + previous close +
//   day open with ~real-time data for US equities. Unofficial endpoint: it can
//   change without notice, so everything sits behind a PriceProvider interface.
//   Rate budget: 1 req/symbol/tick, <=12 symbols, 90s tick => ~480 req/h worst
//   case, well within tolerated usage. A 55s in-process cache dedupes ticks.
// - Cross-check/fallback: Wallbit /assets/{symbol} price (needs API key). Its
//   freshness is unverified until the key exists; `bun run verify` measures it.
//   Wallbit lacks previous close, so pct_change triggers degrade gracefully
//   (rules needing prevClose simply do not fire) when Yahoo is down.
// - Set PRICE_SOURCE=wallbit to flip the primary once verified.

import { config } from "./config.ts";
import { log } from "./log.ts";
import type { Quote } from "./rules.ts";
import { wallbit } from "./wallbit.ts";

export interface PriceProvider {
  name: string;
  getQuote(ticker: string): Promise<Quote | null>;
}

interface YahooChartResponse {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
      indicators?: { quote?: { open?: (number | null)[] }[] };
    }[];
    error?: unknown;
  };
}

export class YahooProvider implements PriceProvider {
  name = "yahoo";

  async getQuote(ticker: string): Promise<Quote | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) wallbit-agent/0.1" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log.warn(`yahoo quote http ${res.status}`, { ticker });
        return null;
      }
      const json = (await res.json()) as YahooChartResponse;
      const result = json.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta?.regularMarketPrice) return null;
      const opens = result?.indicators?.quote?.[0]?.open ?? [];
      const dayOpen = opens.find((o) => o !== null && o !== undefined) ?? null;
      return {
        ticker,
        price: meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        dayOpen,
        ts: (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
        source: this.name,
      };
    } catch (err) {
      log.warn("yahoo quote failed", { ticker, err: String(err) });
      return null;
    }
  }
}

export class WallbitPriceProvider implements PriceProvider {
  name = "wallbit";

  async getQuote(ticker: string): Promise<Quote | null> {
    try {
      const asset = await wallbit.getAsset(ticker);
      if (!asset || typeof asset.price !== "number" || asset.price <= 0) return null;
      return {
        ticker,
        price: asset.price,
        prevClose: null, // Wallbit assets endpoint does not expose prev close
        dayOpen: null,
        ts: Date.now(),
        source: this.name,
      };
    } catch (err) {
      log.warn("wallbit quote failed", { ticker, err: String(err) });
      return null;
    }
  }
}

const cache = new Map<string, { quote: Quote; fetchedAt: number }>();

function providers(): PriceProvider[] {
  const yahoo = new YahooProvider();
  const wb = new WallbitPriceProvider();
  return config.priceSource === "wallbit" ? [wb, yahoo] : [yahoo, wb];
}

export async function getQuote(ticker: string): Promise<Quote | null> {
  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < config.priceCacheTtlSec * 1000) return cached.quote;

  for (const provider of providers()) {
    if (provider.name === "wallbit" && !wallbit.hasKey) continue;
    const quote = await provider.getQuote(ticker);
    if (quote) {
      // Preserve prevClose from a previous richer quote if this source lacks it.
      if (quote.prevClose === null && cached?.quote.prevClose != null) quote.prevClose = cached.quote.prevClose;
      cache.set(ticker, { quote, fetchedAt: Date.now() });
      return quote;
    }
  }
  log.warn("no quote from any provider", { ticker });
  return cached?.quote ?? null;
}

export async function getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()))];
  const results = await Promise.all(unique.map(async (t) => ({ t, q: await getQuote(t) })));
  for (const { t, q } of results) {
    if (q) out.set(t, q);
  }
  return out;
}

export function clearPriceCache() {
  cache.clear();
}

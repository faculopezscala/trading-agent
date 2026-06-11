// Typed HTTP client for the Wallbit public API.
// Docs: https://developer.wallbit.io (endpoints confirmed against the
// official wallbit-skills spec). Base: https://api.wallbit.io/api/public/v1

import { config } from "./config.ts";
import { log } from "./log.ts";

export class WallbitError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "WallbitError";
  }
}

export interface CheckingBalance {
  currency: string;
  balance: number;
}

export interface StockHolding {
  symbol: string; // "USD" row = investment cash
  shares: number;
}

export interface WallbitAsset {
  symbol: string;
  name: string;
  price: number;
  asset_type: string;
  exchange?: string;
  sector?: string;
}

export interface TradeRequest {
  symbol: string;
  direction: "BUY" | "SELL";
  currency: "USD";
  order_type: "MARKET";
  amount?: number;
  shares?: number;
}

export interface TradeResponse {
  symbol: string;
  direction: "BUY" | "SELL";
  amount?: number;
  shares?: number;
  status: string; // e.g. REQUESTED
  order_type: string;
  created_at: string;
  updated_at: string;
}

export interface WallbitTransaction {
  [key: string]: unknown;
}

export class WallbitClient {
  constructor(
    private apiKey: string = config.wallbitApiKey,
    private baseUrl: string = config.wallbitBaseUrl,
  ) {}

  get hasKey(): boolean {
    return this.apiKey.length > 0 && !this.apiKey.toLowerCase().includes("placeholder");
  }

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    if (!this.hasKey) throw new WallbitError(401, null, "WALLBIT_API_KEY not configured");
    const url = `${this.baseUrl}/api/public/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "30");
      const waitSec = Math.min(Number.isNaN(retryAfter) ? 30 : retryAfter, 120);
      log.warn(`wallbit 429, retrying in ${waitSec}s`, { path });
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return this.request<T>(method, path, body, attempt + 1);
    }

    let json: unknown = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }

    if (!res.ok) {
      const msg = (json as { message?: string })?.message ?? `Wallbit API error ${res.status}`;
      throw new WallbitError(res.status, json, `${msg} (${method} ${path})`);
    }
    return json as T;
  }

  async getCheckingBalance(): Promise<CheckingBalance[]> {
    const res = await this.request<{ data: CheckingBalance[] }>("GET", "/balance/checking");
    return res.data;
  }

  // Investment portfolio: stock holdings + a USD row with investable cash.
  async getStocksBalance(): Promise<StockHolding[]> {
    const res = await this.request<{ data: StockHolding[] }>("GET", "/balance/stocks");
    return res.data;
  }

  async getAsset(symbol: string): Promise<WallbitAsset | null> {
    try {
      const res = await this.request<{ data: WallbitAsset }>("GET", `/assets/${encodeURIComponent(symbol)}`);
      return res.data;
    } catch (err) {
      if (err instanceof WallbitError && err.status === 404) return null;
      throw err;
    }
  }

  async listAssets(params: { category?: string; search?: string; page?: number; limit?: number } = {}): Promise<{
    data: WallbitAsset[];
    pages: number;
    count: number;
  }> {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.search) qs.set("search", params.search);
    qs.set("page", String(params.page ?? 1));
    qs.set("limit", String(params.limit ?? 50));
    return this.request("GET", `/assets?${qs.toString()}`);
  }

  async createTrade(req: TradeRequest): Promise<TradeResponse> {
    const res = await this.request<{ data: TradeResponse }>("POST", "/trades", req);
    return res.data;
  }

  async listTransactions(params: { page?: number; limit?: number; currency?: string } = {}): Promise<{ data: WallbitTransaction[] }> {
    const qs = new URLSearchParams();
    qs.set("page", String(params.page ?? 1));
    qs.set("limit", String(params.limit ?? 20));
    if (params.currency) qs.set("currency", params.currency);
    return this.request("GET", `/transactions?${qs.toString()}`);
  }

  async getFees(): Promise<unknown> {
    return this.request("POST", "/fees", { type: "TRADE" });
  }
}

export const wallbit = new WallbitClient();

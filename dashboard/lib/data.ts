// Read-only access to the public Supabase mirror (anon key + RLS).
// Every helper degrades to empty data so the page renders even if the
// mirror is down: the agent itself never depends on this.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function sb<T>(path: string): Promise<T[]> {
  if (!URL || !KEY) return [];
  try {
    const res = await fetch(`${URL}/rest/v1/${path}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

export interface AgentStatus {
  updated_at: string;
  mode: "dry_run" | "notify" | "live";
  initial_capital: number;
  equity_usd: number | null;
  benchmark_equity_usd: number | null;
  kill_switch: boolean;
  thesis: string | null;
  thesis_date: string | null;
  api_cost_total_usd: number | null;
  realized_pnl_usd: number | null;
}

export interface Snapshot {
  ts: string;
  date: string;
  equity_usd: number;
  benchmark_equity_usd: number | null;
}

export interface Position {
  ticker: string;
  shares: number;
  avg_cost: number;
  cost_basis: number;
  last_price: number | null;
  market_value: number | null;
  pnl_usd: number | null;
}

export interface Trade {
  ts: string;
  ticker: string;
  side: string;
  mode: string;
  status: string;
  req_amount_usd: number | null;
  fill_usd: number | null;
  fill_price: number | null;
  reason: string | null;
}

export interface JournalEntry {
  date: string;
  type: string;
  content: string;
  created_at: string;
}

export async function getStatus(): Promise<AgentStatus | null> {
  const rows = await sb<AgentStatus>("agent_status?id=eq.1&limit=1");
  return rows[0] ?? null;
}

export async function getSnapshots(): Promise<Snapshot[]> {
  const rows = await sb<Snapshot>(
    "snapshots?select=ts,date,equity_usd,benchmark_equity_usd&order=id.asc&limit=5000",
  );
  if (rows.length <= 500) return rows;
  const step = Math.ceil(rows.length / 500);
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
}

export async function getPositions(): Promise<Position[]> {
  return sb<Position>("positions?select=*&order=ticker.asc");
}

export async function getTrades(): Promise<Trade[]> {
  return sb<Trade>("trades?select=*&order=id.desc&limit=15");
}

export async function getJournal(): Promise<JournalEntry[]> {
  return sb<JournalEntry>("journal?select=date,type,content,created_at&order=created_at.desc&limit=4");
}

// ---------------------------------------------------------------------------
// Bitcoin history for the "Cartera Adorni" benchmark. Yahoo chart API
// (same unofficial source the agent uses for stocks). Best-effort: if it
// fails, the BTC line simply does not render.
// ---------------------------------------------------------------------------

interface YahooChart {
  chart?: {
    result?: {
      timestamp?: number[];
      meta?: { regularMarketPrice?: number };
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

async function yahooHistory(symbol: string, sinceTs: number): Promise<[number, number][]> {
  const days = Math.max(1, (Date.now() - sinceTs) / 86_400_000);
  const range = days <= 4 ? "5d" : days <= 28 ? "1mo" : days <= 85 ? "3mo" : "1y";
  const interval = days <= 4 ? "15m" : days <= 28 ? "1h" : "1d";
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
      { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) wallbit-dashboard/0.1" }, next: { revalidate: 300 } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as YahooChart;
    const result = json.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const out: [number, number][] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close !== null && close !== undefined) out.push([timestamps[i]! * 1000, close]);
    }
    const spot = result?.meta?.regularMarketPrice;
    if (spot) out.push([Date.now(), spot]);
    return out;
  } catch {
    return [];
  }
}

// "Cartera Adorni": same money thrown into Bitcoin.
export async function getBtcHistory(sinceTs: number): Promise<[number, number][]> {
  return yahooHistory("BTC-USD", sinceTs);
}

// S&P 500 benchmark, drawn from day one even before the agent has data.
export async function getSpyHistory(sinceTs: number): Promise<[number, number][]> {
  return yahooHistory("SPY", sinceTs);
}

// Spot price for the "compro en 2013" gag in the about page.
export async function getBtcSpot(): Promise<number | null> {
  const history = await getBtcHistory(Date.now() - 86_400_000);
  return history.length > 0 ? history[history.length - 1]![1] : null;
}

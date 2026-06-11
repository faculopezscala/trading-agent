// Competitor series for the public race chart. Everyone starts on day 1
// with the same capital as the agent:
// - S&P 500 (SPY): the boring real benchmark.
// - "Cartera Adorni": same capital thrown into Bitcoin on day 1.
// - "Bot Cositorto": the scam promise, +100% compounded monthly. Pure math.
//
// The three rivals are drawn from real Yahoo history (plus math for Cositorto),
// so the chart has life even before the agent has published a single day. When
// the agent has no snapshots yet we anchor to a short "preview" window.

import type { Snapshot } from "./data";

export interface SeriesPoint {
  ts: number;
  value: number;
}

export interface Series {
  key: string;
  name: string;
  sub?: string;
  color: string;
  dash?: string;
  emphasis?: boolean;
  fantasy?: boolean; // not a real attainable return (the joke line)
  points: SeriesPoint[];
}

const DAY_MS = 86_400_000;
const PREVIEW_DAYS = 14;
const COSTIORTO_POINTS = 48;

// Placeholder capital until the real number syncs from the agent.
export const DEFAULT_CAPITAL = 100;

// "Cartera Adorni": the genius who put it all into Bitcoin back in 2013.
// We value $capital bought at the 2013 price against today's spot, so the
// line sits pinned at the very top, asymptotic, far above everyone else.
export const BTC_2013_PRICE = 130;
const DEFAULT_BTC_SPOT = 100_000; // fallback if the live spot fetch fails

// 2x per month, compounded continuously per day: 2^(days/30)
export function costiortoValue(capital: number, day1Ts: number, ts: number): number {
  const days = Math.max(0, (ts - day1Ts) / DAY_MS);
  return capital * Math.pow(2, days / 30);
}

export function experimentWindow(snapshots: Snapshot[]): { day1Ts: number; nowTs: number; isPreview: boolean } {
  if (snapshots.length > 0) {
    return { day1Ts: Date.parse(snapshots[0]!.ts), nowTs: Date.now(), isPreview: false };
  }
  return { day1Ts: Date.now() - PREVIEW_DAYS * DAY_MS, nowTs: Date.now(), isPreview: true };
}

function closestPrice(history: [number, number][], ts: number): number | null {
  if (history.length === 0) return null;
  let best = history[0]!;
  let bestDist = Math.abs(best[0] - ts);
  for (const p of history) {
    const d = Math.abs(p[0] - ts);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best[1];
}

function normalized(
  meta: Omit<Series, "points">,
  history: [number, number][],
  capital: number,
  day1Ts: number,
  nowTs: number,
): Series {
  const base = closestPrice(history, day1Ts);
  if (!base || base <= 0) return { ...meta, points: [] };
  const points = history
    .filter(([ts]) => ts >= day1Ts - DAY_MS && ts <= nowTs + DAY_MS)
    .map(([ts, price]) => ({ ts: Math.min(Math.max(ts, day1Ts), nowTs), value: capital * (price / base) }));
  return { ...meta, points };
}

function costiortoSeries(meta: Omit<Series, "points">, capital: number, day1Ts: number, nowTs: number): Series {
  const span = Math.max(nowTs - day1Ts, DAY_MS);
  const points: SeriesPoint[] = [];
  for (let i = 0; i <= COSTIORTO_POINTS; i++) {
    const ts = day1Ts + (span * i) / COSTIORTO_POINTS;
    points.push({ ts, value: costiortoValue(capital, day1Ts, ts) });
  }
  return { ...meta, points };
}

export function buildSeries(opts: {
  snapshots: Snapshot[];
  capital: number;
  day1Ts: number;
  nowTs: number;
  spyHistory: [number, number][];
  btcSpot: number | null;
}): Series[] {
  const { snapshots, capital, day1Ts, nowTs, spyHistory } = opts;
  if (capital <= 0) return [];

  const agent: Series = {
    key: "agent",
    name: "El agente",
    sub: "tradea solo en Wallbit, gane o pierda",
    color: "#16161d",
    emphasis: true,
    points: snapshots.map((s) => ({ ts: Date.parse(s.ts), value: s.equity_usd })),
  };

  const spy = normalized(
    { key: "spy", name: "S&P 500", sub: "lo aburrido", color: "#8a8a8a" },
    spyHistory,
    capital,
    day1Ts,
    nowTs,
  );

  // Adorni already bought in 2013, so his line is flat at an absurd height.
  const btcSpot = opts.btcSpot ?? DEFAULT_BTC_SPOT;
  const adorniValue = capital * (btcSpot / BTC_2013_PRICE);
  const adorni: Series = {
    key: "adorni",
    name: "Cartera Adorni",
    sub: "$100 al Bitcoin en 2013, un genio",
    color: "#d9831f",
    fantasy: true,
    points: [
      { ts: day1Ts, value: adorniValue },
      { ts: nowTs, value: adorniValue },
    ],
  };

  const costiorto = costiortoSeries(
    {
      key: "costiorto",
      name: "Bot Cositorto",
      sub: "duplica tu plata mes a mes",
      color: "#1f8a4c",
      dash: "6 5",
      fantasy: true,
    },
    capital,
    day1Ts,
    nowTs,
  );

  return [agent, spy, adorni, costiorto];
}

export interface Standing {
  series: Series;
  value: number | null;
  returnPct: number | null;
  noData: boolean;
}

function rank(series: Series, capital: number): Standing {
  const last = series.points[series.points.length - 1];
  if (!last) return { series, value: null, returnPct: null, noData: true };
  return { series, value: last.value, returnPct: ((last.value - capital) / capital) * 100, noData: false };
}

export function standings(series: Series[], capital: number): Standing[] {
  const agent = series.find((s) => s.key === "agent");
  const rivals = series.filter((s) => s.key !== "agent" && s.points.length > 0).map((s) => rank(s, capital));
  rivals.sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));

  if (!agent) return rivals;
  const agentStanding = rank(agent, capital);
  // Once the agent has data it joins the real race; until then it sits on top
  // as the protagonist with a "sin data" note.
  if (agentStanding.noData) return [agentStanding, ...rivals];
  return [agentStanding, ...rivals].sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity));
}

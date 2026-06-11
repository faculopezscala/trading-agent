// Deterministic pre-trade checks. These run on every order, the planner has
// no way to override them. Pure functions, fully unit-testable.

export interface OrderIntent {
  ticker: string;
  side: "buy" | "sell";
  amountUsd: number | null; // required for buys
  shares: number | null; // used for sells
  hasStopLoss: boolean;
}

export interface PositionState {
  ticker: string;
  shares: number;
  costBasis: number;
  marketValue: number;
}

export interface AssetCheck {
  inCatalog: boolean;
  price: number | null;
  assetType: string | null; // "Stock" | "ETF" | ...
}

export interface AccountStateBase {
  initialCapital: number;
  equity: number;
  cash: number;
  dayStartEquity: number | null;
  ordersToday: number;
  buysFrozen: boolean;
  killSwitchActive: boolean;
  positions: PositionState[];
}

export interface AccountState extends AccountStateBase {
  asset: AssetCheck | null;
}

export interface GuardrailConfig {
  maxPositionPct: number; // 0.4
  maxOrdersPerDay: number; // 8
  dailyStopPct: number; // -0.08
  killSwitchEquityPct: number; // 0.65
  minAssetPriceUsd: number; // 5
  minOrderUsd: number; // 1
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxPositionPct: 0.4,
  maxOrdersPerDay: 8,
  dailyStopPct: -0.08,
  killSwitchEquityPct: 0.65,
  minAssetPriceUsd: 5,
  minOrderUsd: 1,
};

export type GuardrailResult = { ok: true } | { ok: false; code: string; reason: string };

function reject(code: string, reason: string): GuardrailResult {
  return { ok: false, code, reason };
}

export function dayPnlPct(state: AccountStateBase): number | null {
  if (state.dayStartEquity === null || state.dayStartEquity === 0) return null;
  return (state.equity - state.dayStartEquity) / state.dayStartEquity;
}

export function killSwitchBreached(state: AccountStateBase, cfg: GuardrailConfig): boolean {
  return state.initialCapital > 0 && state.equity < cfg.killSwitchEquityPct * state.initialCapital;
}

export function dailyStopBreached(state: AccountStateBase, cfg: GuardrailConfig): boolean {
  const pnl = dayPnlPct(state);
  return pnl !== null && pnl <= cfg.dailyStopPct;
}

export function checkOrder(intent: OrderIntent, state: AccountState, cfg: GuardrailConfig = DEFAULT_GUARDRAILS): GuardrailResult {
  // 1. Kill switch: everything frozen, read-only until manual intervention.
  if (state.killSwitchActive || killSwitchBreached(state, cfg)) {
    return reject("kill_switch", `equity ${state.equity.toFixed(2)} below ${(cfg.killSwitchEquityPct * 100).toFixed(0)}% of initial capital ${state.initialCapital}`);
  }

  if (intent.side === "sell") {
    // Exits are always allowed (daily stop and order cap only freeze buys).
    const pos = state.positions.find((p) => p.ticker === intent.ticker);
    if (!pos || pos.shares <= 0) return reject("no_position", `no open position in ${intent.ticker}`);
    return { ok: true };
  }

  // ---- buy checks ----
  if (intent.amountUsd === null || intent.amountUsd < cfg.minOrderUsd) {
    return reject("bad_amount", `buy amount must be >= $${cfg.minOrderUsd}`);
  }
  if (!intent.hasStopLoss) {
    return reject("missing_stop_loss", "every buy must carry a stop loss");
  }
  if (state.buysFrozen) {
    return reject("daily_stop", "buys frozen for the rest of the day (daily stop)");
  }
  if (dailyStopBreached(state, cfg)) {
    return reject("daily_stop", `day P&L ${(dayPnlPct(state)! * 100).toFixed(2)}% breached ${(cfg.dailyStopPct * 100).toFixed(0)}%`);
  }
  if (state.ordersToday >= cfg.maxOrdersPerDay) {
    return reject("max_orders", `order cap reached (${state.ordersToday}/${cfg.maxOrdersPerDay})`);
  }

  // Universe: must exist in the Wallbit catalog, no penny stocks.
  if (!state.asset || !state.asset.inCatalog) {
    return reject("not_in_catalog", `${intent.ticker} not found in Wallbit catalog`);
  }
  if (state.asset.price === null || state.asset.price <= cfg.minAssetPriceUsd) {
    return reject("penny_stock", `${intent.ticker} price ${state.asset.price} <= $${cfg.minAssetPriceUsd}`);
  }

  // Cash: never spend more than what is sitting in the investment account.
  if (intent.amountUsd > state.cash + 0.01) {
    return reject("insufficient_cash", `amount ${intent.amountUsd} > cash ${state.cash.toFixed(2)}`);
  }

  // Total invested can never exceed the initially deposited capital.
  const investedCostBasis = state.positions.reduce((acc, p) => acc + p.costBasis, 0);
  if (investedCostBasis + intent.amountUsd > state.initialCapital + 0.01) {
    return reject("max_invested", `invested ${investedCostBasis.toFixed(2)} + ${intent.amountUsd} exceeds initial capital ${state.initialCapital}`);
  }

  // Per-position cap: 40% of initial capital, counting current market value.
  const pos = state.positions.find((p) => p.ticker === intent.ticker);
  const positionValue = pos?.marketValue ?? 0;
  const cap = cfg.maxPositionPct * state.initialCapital;
  if (positionValue + intent.amountUsd > cap + 0.01) {
    return reject("position_cap", `${intent.ticker} would be ${(positionValue + intent.amountUsd).toFixed(2)} > cap ${cap.toFixed(2)} (${cfg.maxPositionPct * 100}% of capital)`);
  }

  return { ok: true };
}

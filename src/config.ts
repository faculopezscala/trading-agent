function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number for env var ${key}: ${v}`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

export type ExecutionMode = "dry_run" | "notify" | "live";

function executionMode(): ExecutionMode {
  const raw = process.env.EXECUTION_MODE?.toLowerCase().trim();
  if (raw === "dry_run" || raw === "notify" || raw === "live") return raw;
  if (raw) throw new Error(`Invalid EXECUTION_MODE: ${raw} (use dry_run | notify | live)`);
  // Backward compat with the old LIVE flag.
  return envBool("LIVE", false) ? "live" : "dry_run";
}

export const config = {
  // dry_run: paper fills | notify: signal -> manual execution in the Wallbit
  // app (free plan, read-only key) | live: direct API trades (Wallbit Pro).
  executionMode: executionMode(),
  get live(): boolean {
    return this.executionMode === "live";
  },

  wallbitApiKey: process.env.WALLBIT_API_KEY ?? "",
  wallbitBaseUrl: env("WALLBIT_BASE_URL", "https://api.wallbit.io"),

  anthropicApiKey: env("ANTHROPIC_API_KEY", ""),
  // Opus 4.8 is the brain but expensive (~$1/run with web search), so it only
  // does the deep plan once a week (DEEP_PLAN_WEEKDAY). The other trading days
  // a cheaper model adjusts within that week's thesis. Keeps spend < $10/mo.
  plannerModel: env("PLANNER_MODEL", "claude-opus-4-8"),
  dailyModel: env("DAILY_MODEL", "claude-sonnet-4-6"),
  weeklyDeepPlan: envBool("WEEKLY_DEEP_PLAN", true),
  deepPlanWeekday: envNum("DEEP_PLAN_WEEKDAY", 1), // 1=Monday (0=Sun..6=Sat)
  reviewModel: env("REVIEW_MODEL", "claude-fable-5"),
  reviewFallbackModel: env("REVIEW_FALLBACK_MODEL", "claude-sonnet-4-6"),
  escalationModel: env("ESCALATION_MODEL", "claude-haiku-4-5"),

  // Web-search budget: generous on the weekly deep run, tight on daily runs.
  deepMaxWebSearches: envNum("DEEP_MAX_WEB_SEARCHES", 6),
  plannerMaxWebSearches: envNum("PLANNER_MAX_WEB_SEARCHES", 3),
  plannerMaxOutputTokens: envNum("PLANNER_MAX_OUTPUT_TOKENS", 3000),
  middayEnabled: envBool("MIDDAY_ENABLED", false),

  tickIntervalSec: envNum("TICK_INTERVAL_SEC", 90),

  // Capital used in dry-run mode and as initial capital reference until
  // the live account is initialized via `bun run verify --init`.
  initialCapitalUsd: envNum("INITIAL_CAPITAL_USD", 100),

  // Guardrails (hard limits, the planner cannot override these)
  maxPositionPct: envNum("MAX_POSITION_PCT", 0.4),
  maxOrdersPerDay: envNum("MAX_ORDERS_PER_DAY", 8),
  dailyStopPct: envNum("DAILY_STOP_PCT", -0.08),
  killSwitchEquityPct: envNum("KILL_SWITCH_EQUITY_PCT", 0.65),
  minAssetPriceUsd: envNum("MIN_ASSET_PRICE_USD", 5),

  webhookUrl: process.env.WEBHOOK_URL ?? "",

  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ?? "",
  syncIntervalMin: envNum("SYNC_INTERVAL_MIN", 15),

  dbPath: env("DB_PATH", "data/agent.db"),
  logDir: env("LOG_DIR", "logs"),
  logRetentionDays: envNum("LOG_RETENTION_DAYS", 14),

  benchmarkTicker: env("BENCHMARK_TICKER", "SPY"),

  // Primary intraday price source: "yahoo" | "wallbit".
  // Default yahoo: Wallbit asset price freshness is unverified and the
  // /assets endpoint does not expose previous close (needed for pct triggers).
  priceSource: env("PRICE_SOURCE", "yahoo"),
  priceCacheTtlSec: envNum("PRICE_CACHE_TTL_SEC", 55),

  costAlertDailyUsd: envNum("COST_ALERT_DAILY_USD", 1.5),
};

export type Config = typeof config;

// USD per million tokens. Override with MODEL_PRICING_JSON env var, e.g.
// {"claude-sonnet-4-6":{"input":3,"output":15,"cacheWrite":3.75,"cacheRead":0.3}}
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-fable-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export const WEB_SEARCH_COST_USD = 0.01; // $10 per 1000 searches

export function pricingFor(model: string): ModelPricing {
  const override = process.env.MODEL_PRICING_JSON;
  if (override) {
    try {
      const parsed = JSON.parse(override) as Record<string, ModelPricing>;
      if (parsed[model]) return parsed[model];
    } catch {
      // fall through to defaults
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_PRICING)) {
    if (model.startsWith(key)) return value;
  }
  return { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };
}

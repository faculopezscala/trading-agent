// Long-running entrypoint (local / always-on machine). Boots once, then runs
// the agent loop every 15s. For the ephemeral GitHub Actions cron path see
// src/tick.ts, which reuses the same core from src/agent.ts.

import { config } from "./config.ts";
import { bootChecks, runOnce } from "./agent.ts";
import { log } from "./log.ts";
import { todayET } from "./market.ts";
import { notify } from "./notify.ts";

process.on("uncaughtException", async (err) => {
  log.error("uncaughtException", { err: String(err), stack: err.stack });
  await notify("crash", "Agent crashed", String(err).slice(0, 500));
  process.exit(1);
});
process.on("unhandledRejection", async (reason) => {
  log.error("unhandledRejection", { reason: String(reason) });
  await notify("crash", "Agent crashed (rejection)", String(reason).slice(0, 500));
  process.exit(1);
});

log.info(`wallbit-agent starting`, {
  mode: config.executionMode,
  tickSec: config.tickIntervalSec,
  plannerModel: config.plannerModel,
  today: todayET(),
});
await bootChecks();
setInterval(() => void runOnce(), 15_000);
void runOnce();

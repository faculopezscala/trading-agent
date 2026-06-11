// One-shot entrypoint for GitHub Actions cron. Restores state from Supabase
// Storage, runs a single agent pass, then persists state back. Idempotent via
// daily_state flags, so running it every few minutes is safe.
//
// The agent core is imported dynamically AFTER downloadDb() because importing
// src/agent.ts opens the SQLite file at module load; the file must be restored
// from storage first.

import { downloadDb, uploadDb } from "./store.ts";
import { log } from "./log.ts";

let code = 0;
try {
  await downloadDb();
  const { bootChecks, runOnce } = await import("./agent.ts");
  await bootChecks({ announce: false });
  await runOnce();
} catch (err) {
  log.error("tick failed", { err: String(err) });
  code = 1;
} finally {
  try {
    await uploadDb();
  } catch (err) {
    log.error("tick: uploadDb failed", { err: String(err) });
    code = 1;
  }
}

process.exit(code);

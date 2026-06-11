// Clears the kill switch after manual review: `bun run unfreeze`.

import { getDb } from "../db.ts";
import { notify } from "../notify.ts";

const db = getDb();
if (db.getMeta("kill_switch") !== "1") {
  console.log("Kill switch is not active. Nothing to do.");
  process.exit(0);
}
db.setMeta("kill_switch", "0");
await notify("info", "Kill switch cleared", "Trading re-enabled manually via bun run unfreeze.");
console.log("Kill switch cleared. Trading re-enabled.");
process.exit(0);

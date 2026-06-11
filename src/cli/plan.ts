// Manual planner run: `bun run plan` (or `bun run plan --midday`).

import { createBroker } from "../broker.ts";
import { getDb } from "../db.ts";
import { runMidday, runPlanner } from "../planner.ts";

const db = getDb();
const broker = createBroker();

if (process.argv.includes("--midday")) {
  await runMidday(db, broker);
} else {
  const res = await runPlanner(db, broker);
  console.log(res.ok ? "Plan published." : "Planner failed, see logs.");
}
process.exit(0);

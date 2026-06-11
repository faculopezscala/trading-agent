// Manual weekly review run: `bun run review`.

import { runWeeklyReview } from "../review.ts";

await runWeeklyReview();
console.log("Weekly review done.");
process.exit(0);

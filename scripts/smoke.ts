// Quick smoke checks: Yahoo quotes + Anthropic model IDs resolve.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../src/config.ts";
import { getQuotes } from "../src/prices.ts";

console.log("1) Yahoo quotes...");
const quotes = await getQuotes(["SPY", "NVDA", "AAPL"]);
for (const [t, q] of quotes) {
  const age = ((Date.now() - q.ts) / 60000).toFixed(1);
  console.log(`   ${t}: $${q.price} prevClose=${q.prevClose} (source=${q.source}, age ${age}min)`);
}
if (quotes.size === 0) {
  console.error("   FAIL: no quotes");
  process.exit(1);
}

console.log("2) Anthropic model IDs...");
const client = new Anthropic({ apiKey: config.anthropicApiKey });
for (const model of [config.plannerModel, config.reviewModel, config.escalationModel]) {
  try {
    const res = await client.messages.create({ model, max_tokens: 8, messages: [{ role: "user", content: "say ok" }] });
    console.log(`   ${model}: OK (${res.usage.input_tokens} in / ${res.usage.output_tokens} out)`);
  } catch (err) {
    console.log(`   ${model}: FAILED -> ${String(err).slice(0, 140)}`);
  }
}
console.log("done");

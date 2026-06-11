// Thin wrapper over the Anthropic SDK: prompt caching on the system prompt,
// optional web search tool, and per-call cost accounting into SQLite.

import Anthropic from "@anthropic-ai/sdk";
import { config, pricingFor, WEB_SEARCH_COST_USD } from "./config.ts";
import { getDb } from "./db.ts";
import { log } from "./log.ts";
import { todayET } from "./market.ts";

const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 });

export interface LlmCallOptions {
  purpose: string; // planner | midday | review | escalation
  model: string;
  system: string; // static part, cached
  userMessage: string;
  maxTokens: number;
  webSearch?: { maxUses: number };
}

export interface LlmResult {
  text: string;
  costUsd: number;
  webSearches: number;
  stopReason: string | null;
}

export async function callClaude(opts: LlmCallOptions): Promise<LlmResult> {
  const tools: Anthropic.Messages.ToolUnion[] =
    opts.webSearch && opts.webSearch.maxUses > 0
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: opts.webSearch.maxUses }]
      : [];

  const started = Date.now();
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.userMessage }],
    ...(tools.length > 0 ? { tools } : {}),
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const usage = response.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const webSearches = usage.server_tool_use?.web_search_requests ?? 0;

  const pricing = pricingFor(opts.model);
  const costUsd =
    (inputTokens * pricing.input +
      cacheWrite * pricing.cacheWrite +
      cacheRead * pricing.cacheRead +
      outputTokens * pricing.output) /
      1_000_000 +
    webSearches * WEB_SEARCH_COST_USD;

  getDb().addApiCost({
    date: todayET(),
    purpose: opts.purpose,
    model: opts.model,
    inputTokens,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens,
    webSearches,
    costUsd,
  });

  log.info(`llm call ${opts.purpose}`, {
    model: opts.model,
    ms: Date.now() - started,
    inputTokens,
    cacheRead,
    outputTokens,
    webSearches,
    costUsd: Number(costUsd.toFixed(4)),
    stopReason: response.stop_reason,
  });

  return { text, costUsd, webSearches, stopReason: response.stop_reason };
}

import { config } from "./config.ts";
import { log } from "./log.ts";
import { getDb } from "./db.ts";

export type NotifyEvent =
  | "plan_published"
  | "midday_adjusted"
  | "order_signal"
  | "order_missed"
  | "order_executed"
  | "order_failed"
  | "daily_stop"
  | "kill_switch"
  | "planner_failed"
  | "crash"
  | "restart"
  | "weekly_review"
  | "cost_alert"
  | "info";

// Webhook payload adapts to Discord ({content}) and Slack ({text}) URLs,
// otherwise sends a generic JSON envelope.
export async function notify(event: NotifyEvent, title: string, message: string, data?: unknown): Promise<void> {
  try {
    getDb().addEvent(event, { title, message, data });
  } catch (err) {
    log.warn("event log failed", { err: String(err) });
  }

  log.info(`[notify:${event}] ${title} - ${message}`);
  if (!config.webhookUrl) return;

  const text = `**[${event}] ${title}**\n${message}`;
  let body: unknown;
  if (config.webhookUrl.includes("discord.com")) {
    body = { content: text.slice(0, 1900) };
  } else if (config.webhookUrl.includes("slack.com")) {
    body = { text: text.slice(0, 3000) };
  } else {
    body = { event, title, message, data: data ?? null, ts: new Date().toISOString() };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok || res.status === 204) return;
      log.warn(`webhook responded ${res.status}, attempt ${attempt + 1}`);
    } catch (err) {
      log.warn(`webhook failed, attempt ${attempt + 1}`, { err: String(err) });
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

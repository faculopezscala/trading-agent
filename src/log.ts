import { mkdirSync, readdirSync, unlinkSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let currentDay = "";
let currentPath = "";

function logFile(): string {
  const day = today();
  if (day !== currentDay) {
    currentDay = day;
    mkdirSync(config.logDir, { recursive: true });
    currentPath = join(config.logDir, `agent-${day}.log`);
  }
  return currentPath;
}

function write(level: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const suffix = extra === undefined ? "" : ` ${safeJson(extra)}`;
  const line = `${ts} [${level}] ${msg}${suffix}`;
  console.log(line);
  try {
    appendFileSync(logFile(), line + "\n");
  } catch {
    // never let logging take down the process
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => write("INFO", msg, extra),
  warn: (msg: string, extra?: unknown) => write("WARN", msg, extra),
  error: (msg: string, extra?: unknown) => write("ERROR", msg, extra),
};

// Text logs rotate out after N days. SQLite data is permanent and never cleaned.
export function cleanOldLogs() {
  try {
    mkdirSync(config.logDir, { recursive: true });
    const cutoff = Date.now() - config.logRetentionDays * 24 * 3600 * 1000;
    for (const f of readdirSync(config.logDir)) {
      if (!f.startsWith("agent-") || !f.endsWith(".log")) continue;
      const full = join(config.logDir, f);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    }
  } catch (err) {
    log.warn("log cleanup failed", { err: String(err) });
  }
}

// Persists the SQLite state file in Supabase Storage so the agent can run on
// ephemeral runners (GitHub Actions cron). Each tick: downloadDb() at start,
// uploadDb() at the end. No-ops when Supabase is not configured (local dev),
// so the same code keeps working against the on-disk DB.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { log } from "./log.ts";

const BUCKET = "agent-state";
const OBJECT = "agent.db";

function enabled(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceKey);
}

function storageUrl(path: string): string {
  return `${config.supabaseUrl}/storage/v1/${path}`;
}

function authHeaders(): Record<string, string> {
  return {
    apikey: config.supabaseServiceKey,
    Authorization: `Bearer ${config.supabaseServiceKey}`,
  };
}

async function ensureBucket(): Promise<void> {
  try {
    const res = await fetch(storageUrl("bucket"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
    });
    // 200 created, 400/409 already exists: both fine.
    if (!res.ok && res.status !== 400 && res.status !== 409) {
      log.warn("ensureBucket unexpected status", { status: res.status });
    }
  } catch (err) {
    log.warn("ensureBucket failed", { err: String(err) });
  }
}

export async function downloadDb(): Promise<void> {
  if (!enabled()) {
    log.info("store: Supabase not configured, using local DB only");
    return;
  }
  await ensureBucket();
  try {
    const res = await fetch(storageUrl(`object/${BUCKET}/${OBJECT}`), { headers: authHeaders() });
    if (res.status === 404 || res.status === 400) {
      log.info("store: no remote DB yet, starting fresh");
      return;
    }
    if (!res.ok) {
      throw new Error(`download failed: ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(dirname(config.dbPath), { recursive: true });
    await writeFile(config.dbPath, bytes);
    log.info("store: DB downloaded", { bytes: bytes.length });
  } catch (err) {
    // Hard fail: running against an empty DB could re-open closed positions.
    throw new Error(`store.downloadDb: ${String(err)}`);
  }
}

export async function uploadDb(): Promise<void> {
  if (!enabled()) return;
  // Fold the WAL into the main file so a single object holds all state.
  try {
    const { getDb } = await import("./db.ts");
    getDb().sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (err) {
    log.warn("store: wal checkpoint failed", { err: String(err) });
  }
  try {
    const bytes = await readFile(config.dbPath);
    const res = await fetch(storageUrl(`object/${BUCKET}/${OBJECT}`), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: bytes,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    log.info("store: DB uploaded", { bytes: bytes.length });
  } catch (err) {
    throw new Error(`store.uploadDb: ${String(err)}`);
  }
}

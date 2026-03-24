import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const META_FILE = join(DATA_DIR, "sessions-meta.json");

// ── Types ─────────────────────────────────────────────────────────

export interface SessionMeta {
  archived: boolean;
  archivedAt: string;
  // Schedule-triggered session metadata
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
}

type MetaMap = Record<string, SessionMeta>;

// ── Persistence ───────────────────────────────────────────────────

function load(): MetaMap {
  if (!existsSync(META_FILE)) return {};
  try {
    return JSON.parse(readFileSync(META_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(data: MetaMap): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(data, null, 2));
}

// ── API ───────────────────────────────────────────────────────────

export function getMeta(sessionId: string): SessionMeta | undefined {
  return load()[sessionId];
}

export function isArchived(sessionId: string): boolean {
  return load()[sessionId]?.archived === true;
}

export function setArchived(sessionId: string, archived: boolean): SessionMeta {
  const data = load();
  if (archived) {
    data[sessionId] = { archived: true, archivedAt: new Date().toISOString() };
  } else {
    delete data[sessionId];
  }
  save(data);
  return data[sessionId] ?? { archived: false, archivedAt: "" };
}

export function deleteMeta(sessionId: string): void {
  const data = load();
  delete data[sessionId];
  save(data);
}

export function setScheduleMeta(sessionId: string, scheduleId: string, scheduleName: string): void {
  const data = load();
  const existing = data[sessionId] ?? { archived: false, archivedAt: "" };
  data[sessionId] = { ...existing, triggeredBy: "schedule", scheduleId, scheduleName };
  save(data);
}

export function listMeta(): MetaMap {
  return load();
}

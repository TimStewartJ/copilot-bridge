import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ── Factory ───────────────────────────────────────────────────────

export function createSessionMetaStore(dataDir: string) {
  const META_FILE = join(dataDir, "sessions-meta.json");

  function load(): MetaMap {
    if (!existsSync(META_FILE)) return {};
    try {
      return JSON.parse(readFileSync(META_FILE, "utf-8"));
    } catch {
      return {};
    }
  }

  function save(data: MetaMap): void {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(META_FILE, JSON.stringify(data, null, 2));
  }

  function getMeta(sessionId: string): SessionMeta | undefined {
    return load()[sessionId];
  }

  function isArchived(sessionId: string): boolean {
    return load()[sessionId]?.archived === true;
  }

  function setArchived(sessionId: string, archived: boolean): SessionMeta {
    const data = load();
    if (archived) {
      data[sessionId] = { archived: true, archivedAt: new Date().toISOString() };
    } else {
      delete data[sessionId];
    }
    save(data);
    return data[sessionId] ?? { archived: false, archivedAt: "" };
  }

  function deleteMeta(sessionId: string): void {
    const data = load();
    delete data[sessionId];
    save(data);
  }

  function setScheduleMeta(sessionId: string, scheduleId: string, scheduleName: string): void {
    const data = load();
    const existing = data[sessionId] ?? { archived: false, archivedAt: "" };
    data[sessionId] = { ...existing, triggeredBy: "schedule", scheduleId, scheduleName };
    save(data);
  }

  function listMeta(): MetaMap {
    return load();
  }

  return { getMeta, isArchived, setArchived, deleteMeta, setScheduleMeta, listMeta };
}

export type SessionMetaStore = ReturnType<typeof createSessionMetaStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _default = createSessionMetaStore(_defaultDataDir);
export const getMeta = _default.getMeta;
export const isArchived = _default.isArchived;
export const setArchived = _default.setArchived;
export const deleteMeta = _default.deleteMeta;
export const setScheduleMeta = _default.setScheduleMeta;
export const listMeta = _default.listMeta;

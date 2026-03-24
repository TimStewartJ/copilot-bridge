import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────

type ReadStateMap = Record<string, string>; // sessionId → ISO lastReadAt

// ── Factory ───────────────────────────────────────────────────────

export function createReadStateStore(dataDir: string) {
  const READ_STATE_FILE = join(dataDir, "read-state.json");

  function load(): ReadStateMap {
    if (!existsSync(READ_STATE_FILE)) return {};
    try {
      return JSON.parse(readFileSync(READ_STATE_FILE, "utf-8"));
    } catch {
      return {};
    }
  }

  function save(data: ReadStateMap): void {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(READ_STATE_FILE, JSON.stringify(data, null, 2));
  }

  function getReadState(): ReadStateMap {
    return load();
  }

  function markRead(sessionId: string): string {
    const data = load();
    const now = new Date().toISOString();
    data[sessionId] = now;
    save(data);
    return now;
  }

  function isUnread(sessionId: string, modifiedTime?: string): boolean {
    if (!modifiedTime) return false;
    const data = load();
    const lastRead = data[sessionId];
    if (!lastRead) return true; // never opened = unread
    return new Date(modifiedTime).getTime() > new Date(lastRead).getTime();
  }

  function markUnread(sessionId: string): void {
    const data = load();
    delete data[sessionId];
    save(data);
  }

  function pruneReadState(validSessionIds: Set<string>): void {
    const data = load();
    let changed = false;
    for (const id of Object.keys(data)) {
      if (!validSessionIds.has(id)) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) save(data);
  }

  return { getReadState, markRead, isUnread, markUnread, pruneReadState };
}

export type ReadStateStore = ReturnType<typeof createReadStateStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _default = createReadStateStore(_defaultDataDir);
export const getReadState = _default.getReadState;
export const markRead = _default.markRead;
export const isUnread = _default.isUnread;
export const markUnread = _default.markUnread;
export const pruneReadState = _default.pruneReadState;

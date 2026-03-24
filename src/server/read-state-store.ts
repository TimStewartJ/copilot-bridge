import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const READ_STATE_FILE = join(DATA_DIR, "read-state.json");

// ── Types ─────────────────────────────────────────────────────────

type ReadStateMap = Record<string, string>; // sessionId → ISO lastReadAt

// ── Persistence ───────────────────────────────────────────────────

function load(): ReadStateMap {
  if (!existsSync(READ_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(READ_STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(data: ReadStateMap): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(READ_STATE_FILE, JSON.stringify(data, null, 2));
}

// ── API ───────────────────────────────────────────────────────────

export function getReadState(): ReadStateMap {
  return load();
}

export function markRead(sessionId: string): string {
  const data = load();
  const now = new Date().toISOString();
  data[sessionId] = now;
  save(data);
  return now;
}

export function isUnread(sessionId: string, modifiedTime?: string): boolean {
  if (!modifiedTime) return false;
  const data = load();
  const lastRead = data[sessionId];
  if (!lastRead) return true; // never opened = unread
  return new Date(modifiedTime).getTime() > new Date(lastRead).getTime();
}

export function markUnread(sessionId: string): void {
  const data = load();
  delete data[sessionId];
  save(data);
}

export function pruneReadState(validSessionIds: Set<string>): void {
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

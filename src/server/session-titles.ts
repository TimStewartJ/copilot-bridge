// Session title overrides — stores LLM-generated concise titles
// The SDK CLI uses the full first user message as the session summary.
// We generate better titles and store them here.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Factory ───────────────────────────────────────────────────────

export function createSessionTitlesStore(dataDir: string) {
  const TITLES_FILE = join(dataDir, "session-titles.json");
  let titles: Record<string, string> = {};

  function loadTitles(): void {
    try {
      if (existsSync(TITLES_FILE)) {
        titles = JSON.parse(readFileSync(TITLES_FILE, "utf-8"));
        // Purge any titles that are actually echoed prompt text from a bug
        let dirty = false;
        for (const [id, title] of Object.entries(titles)) {
          if (/generate a concise|3-6 word title/i.test(title)) {
            delete titles[id];
            dirty = true;
          }
        }
        if (dirty) {
          writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
          console.log("[titles] Purged leaked prompt-text titles from session-titles.json");
        }
      }
    } catch {
      titles = {};
    }
  }

  function getTitle(sessionId: string): string | undefined {
    return titles[sessionId];
  }

  function setTitle(sessionId: string, title: string): void {
    titles[sessionId] = title;
    try {
      writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
    } catch (err) {
      console.error("[titles] Failed to persist title:", err);
    }
  }

  function hasTitle(sessionId: string): boolean {
    return sessionId in titles;
  }

  function deleteTitle(sessionId: string): void {
    delete titles[sessionId];
    try {
      writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
    } catch { /* best effort */ }
  }

  function getAllTitles(): Record<string, string> {
    return { ...titles };
  }

  return { loadTitles, getTitle, setTitle, hasTitle, deleteTitle, getAllTitles };
}

export type SessionTitlesStore = ReturnType<typeof createSessionTitlesStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _default = createSessionTitlesStore(_defaultDataDir);
export const loadTitles = _default.loadTitles;
export const getTitle = _default.getTitle;
export const setTitle = _default.setTitle;
export const hasTitle = _default.hasTitle;
export const deleteTitle = _default.deleteTitle;
export const getAllTitles = _default.getAllTitles;

// Session title overrides — stores LLM-generated concise titles
// The SDK CLI uses the full first user message as the session summary.
// We generate better titles and store them here.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITLES_FILE = join(__dirname, "..", "..", "data", "session-titles.json");

let titles: Record<string, string> = {};

export function loadTitles(): void {
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

export function getTitle(sessionId: string): string | undefined {
  return titles[sessionId];
}

export function setTitle(sessionId: string, title: string): void {
  titles[sessionId] = title;
  try {
    writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
  } catch (err) {
    console.error("[titles] Failed to persist title:", err);
  }
}

export function hasTitle(sessionId: string): boolean {
  return sessionId in titles;
}

export function deleteTitle(sessionId: string): void {
  delete titles[sessionId];
  try {
    writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
  } catch { /* best effort */ }
}

export function getAllTitles(): Record<string, string> {
  return { ...titles };
}

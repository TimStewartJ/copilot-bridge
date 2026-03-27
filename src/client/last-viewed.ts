const LAST_VIEWED_KEY = "bridge-last-session";

export function getLastViewedSession(taskId: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) || "{}");
    return map[taskId] ?? null;
  } catch {
    return null;
  }
}

export function setLastViewedSession(taskId: string, sessionId: string) {
  const map = JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) || "{}");
  map[taskId] = sessionId;
  localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map));
}

export function clearLastViewedSession(sessionId: string) {
  const map = JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) || "{}");
  for (const key of Object.keys(map)) {
    if (map[key] === sessionId) delete map[key];
  }
  localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map));
}

// ── Last-viewed doc ──────────────────────────────────────────────

const LAST_DOC_KEY = "bridge-last-doc";

export function getLastViewedDoc(): string | null {
  try {
    return localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}

export function setLastViewedDoc(path: string) {
  localStorage.setItem(LAST_DOC_KEY, path);
}

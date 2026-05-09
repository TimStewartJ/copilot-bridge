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

// ── Last-active task ─────────────────────────────────────────────

const LAST_TASK_KEY = "bridge-last-task";

export function getLastActiveTask(): string | null {
  try {
    return localStorage.getItem(LAST_TASK_KEY);
  } catch {
    return null;
  }
}

export function setLastActiveTask(taskId: string) {
  localStorage.setItem(LAST_TASK_KEY, taskId);
}

export function clearLastActiveTask(taskId: string) {
  try {
    if (localStorage.getItem(LAST_TASK_KEY) === taskId) {
      localStorage.removeItem(LAST_TASK_KEY);
    }
  } catch {}
}

// ── Last-active quick chat ───────────────────────────────────────

const LAST_QUICK_CHAT_KEY = "bridge-last-quick-chat";

export function getLastActiveQuickChat(): string | null {
  try {
    return localStorage.getItem(LAST_QUICK_CHAT_KEY);
  } catch {
    return null;
  }
}

export function setLastActiveQuickChat(sessionId: string) {
  localStorage.setItem(LAST_QUICK_CHAT_KEY, sessionId);
}

export function clearLastActiveQuickChat(sessionId: string) {
  try {
    if (localStorage.getItem(LAST_QUICK_CHAT_KEY) === sessionId) {
      localStorage.removeItem(LAST_QUICK_CHAT_KEY);
    }
  } catch {}
}

import { useState, useCallback, useEffect, useRef } from "react";
import type { Session, Attachment } from "./api";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";
import { isRecord } from "../shared/is-record.js";

const STORAGE_KEY = "copilot-bridge:session-drafts";
const DEBOUNCE_MS = 500;

export interface Draft {
  text: string;
  attachments?: Attachment[];
  launch?: DraftLaunchOptions;
}

type DraftState = Record<string, Draft>; // composerKey → Draft

export interface DraftScopedLaunchSelection<T extends string> {
  modelId: string;
  value: T;
}

export interface DraftLaunchOptions {
  model?: string;
  reasoningEffort?: DraftScopedLaunchSelection<string>;
  contextTier?: DraftScopedLaunchSelection<CopilotContextTier>;
}

type DraftLaunchOptionsUpdate =
  | DraftLaunchOptions
  | undefined
  | ((current: DraftLaunchOptions | undefined) => DraftLaunchOptions | undefined);

interface NormalizedValue<T> {
  value?: T;
  changed: boolean;
}

interface LoadedDraftState {
  state: DraftState;
  needsRewrite: boolean;
}

function isRouteDraftKey(key: string): boolean {
  return key.startsWith("draft:");
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeAttachment(value: unknown): NormalizedValue<Attachment> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { changed: true };
  }

  if (value.type === "blob") {
    if (typeof value.data !== "string" || typeof value.mimeType !== "string") {
      return { changed: true };
    }
    const displayName = typeof value.displayName === "string" ? value.displayName : undefined;
    return {
      value: {
        type: "blob",
        data: value.data,
        mimeType: value.mimeType,
        ...(displayName !== undefined ? { displayName } : {}),
      },
      changed: !hasOnlyKeys(value, ["type", "data", "mimeType", "displayName"])
        || ("displayName" in value && displayName === undefined),
    };
  }

  if (value.type === "uploaded") {
    if (
      typeof value.displayName !== "string"
      || typeof value.mimeType !== "string"
      || typeof value.size !== "number"
      || !Number.isFinite(value.size)
      || value.size < 0
    ) {
      return { changed: true };
    }
    return {
      value: {
        type: "uploaded",
        displayName: value.displayName,
        mimeType: value.mimeType,
        size: value.size,
      },
      changed: !hasOnlyKeys(value, ["type", "displayName", "mimeType", "size"]),
    };
  }

  if (value.type === "file") {
    if (typeof value.path !== "string") {
      return { changed: true };
    }
    const displayName = typeof value.displayName === "string" ? value.displayName : undefined;
    return {
      value: {
        type: "file",
        path: value.path,
        ...(displayName !== undefined ? { displayName } : {}),
      },
      changed: !hasOnlyKeys(value, ["type", "path", "displayName"])
        || ("displayName" in value && displayName === undefined),
    };
  }

  return { changed: true };
}

function normalizeLaunchOptions(value: unknown): NormalizedValue<DraftLaunchOptions> {
  if (!isRecord(value)) return { changed: true };

  let changed = !hasOnlyKeys(value, ["model", "reasoningEffort", "contextTier"]);
  const launch: DraftLaunchOptions = {};

  if ("model" in value) {
    if (isNonEmptyString(value.model)) {
      launch.model = value.model;
    } else {
      changed = true;
    }
  }

  if ("reasoningEffort" in value) {
    const selection = value.reasoningEffort;
    if (
      isRecord(selection)
      && isNonEmptyString(selection.modelId)
      && isNonEmptyString(selection.value)
      && hasOnlyKeys(selection, ["modelId", "value"])
    ) {
      launch.reasoningEffort = {
        modelId: selection.modelId,
        value: selection.value,
      };
    } else {
      changed = true;
    }
  }

  if ("contextTier" in value) {
    const selection = value.contextTier;
    if (
      isRecord(selection)
      && isNonEmptyString(selection.modelId)
      && isCopilotContextTier(selection.value)
      && hasOnlyKeys(selection, ["modelId", "value"])
    ) {
      launch.contextTier = {
        modelId: selection.modelId,
        value: selection.value,
      };
    } else {
      changed = true;
    }
  }

  if (!launch.model && !launch.reasoningEffort && !launch.contextTier) {
    return { changed: true };
  }
  return { value: launch, changed };
}

function normalizeDraft(value: unknown): NormalizedValue<Draft> {
  if (!isRecord(value) || typeof value.text !== "string") {
    return { changed: true };
  }

  let changed = !hasOnlyKeys(value, ["text", "attachments", "launch"]);
  let attachments: Attachment[] | undefined;
  if ("attachments" in value) {
    if (Array.isArray(value.attachments)) {
      const normalized = value.attachments.flatMap((attachment) => {
        const result = normalizeAttachment(attachment);
        if (result.changed) changed = true;
        return result.value ? [result.value] : [];
      });
      if (normalized.length > 0) {
        attachments = normalized;
      } else {
        changed = true;
      }
    } else {
      changed = true;
    }
  }

  let launch: DraftLaunchOptions | undefined;
  if ("launch" in value) {
    const normalized = normalizeLaunchOptions(value.launch);
    if (normalized.changed) changed = true;
    launch = normalized.value;
  }

  const hasContent = value.text.trim().length > 0
    || Boolean(attachments?.length)
    || Boolean(launch);
  if (!hasContent) return { changed: true };

  return {
    value: {
      text: value.text,
      ...(attachments ? { attachments } : {}),
      ...(launch ? { launch } : {}),
    },
    changed,
  };
}

function normalizeDraftState(value: unknown): LoadedDraftState {
  if (!isRecord(value)) {
    return { state: {}, needsRewrite: true };
  }

  const state: DraftState = {};
  let needsRewrite = false;
  for (const [composerKey, draft] of Object.entries(value)) {
    const normalized = normalizeDraft(draft);
    if (normalized.changed) needsRewrite = true;
    if (normalized.value) state[composerKey] = normalized.value;
  }
  return { state, needsRewrite };
}

function buildNextDraftState(
  prev: DraftState,
  sessionId: string,
  text: string,
  attachments?: Attachment[],
): DraftState {
  const trimmed = text.trim();
  const hasContent = trimmed.length > 0 || (attachments && attachments.length > 0);
  const launch = prev[sessionId]?.launch;

  if (!hasContent && !launch) {
    if (!(sessionId in prev)) return prev;
    const next = { ...prev };
    delete next[sessionId];
    return next;
  }

  return {
    ...prev,
    [sessionId]: {
      text,
      ...(attachments?.length ? { attachments } : {}),
      ...(launch ? { launch } : {}),
    },
  };
}

function load(): LoadedDraftState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { state: {}, needsRewrite: false };
  }
  if (!raw) return { state: {}, needsRewrite: false };

  try {
    return normalizeDraftState(JSON.parse(raw));
  } catch {
    return { state: {}, needsRewrite: true };
  }
}

function save(state: DraftState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage quota exceeded — try without attachments
    const slim: DraftState = {};
    for (const [id, draft] of Object.entries(state)) {
      slim[id] = {
        text: draft.text,
        ...(draft.launch ? { launch: draft.launch } : {}),
      };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // give up silently
    }
  }
}

export function useDrafts(sessions: Session[]) {
  const [initialLoad] = useState(load);
  const [state, setState] = useState<DraftState>(initialLoad.state);
  const stateRef = useRef(state);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const sanitizedStorageWrittenRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!initialLoad.needsRewrite || sanitizedStorageWrittenRef.current) return;
    sanitizedStorageWrittenRef.current = true;
    save(stateRef.current);
  }, [initialLoad.needsRewrite]);

  // GC: prune drafts for sessions that no longer exist
  useEffect(() => {
    if (sessions.length === 0) return;
    const validIds = new Set(sessions.map((s) => s.sessionId));
    setState((prev) => {
      let changed = false;
      const pruned: DraftState = {};
      for (const [id, draft] of Object.entries(prev)) {
        if (validIds.has(id) || isRouteDraftKey(id)) {
          pruned[id] = draft;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      save(pruned);
      return pruned;
    });
  }, [sessions]);

  const scheduleSave = useCallback((composerKey: string) => {
    const existingTimer = timersRef.current[composerKey];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    timersRef.current[composerKey] = setTimeout(() => {
      delete timersRef.current[composerKey];
      save(stateRef.current);
    }, DEBOUNCE_MS);
  }, []);

  const clearDraftTimer = useCallback((composerKey: string) => {
    const existingTimer = timersRef.current[composerKey];
    if (!existingTimer) return;
    clearTimeout(existingTimer);
    delete timersRef.current[composerKey];
  }, []);

  const setDraft = useCallback(
    (sessionId: string, text: string, attachments?: Attachment[]) => {
      setState((prev) => {
        const next = buildNextDraftState(prev, sessionId, text, attachments);
        if (next === prev) {
          clearDraftTimer(sessionId);
          return prev;
        }

        stateRef.current = next;
        scheduleSave(sessionId);

        return next;
      });
    },
    [clearDraftTimer, scheduleSave],
  );

  const setDraftImmediate = useCallback((sessionId: string, text: string, attachments?: Attachment[]) => {
    clearDraftTimer(sessionId);
    const next = buildNextDraftState(stateRef.current, sessionId, text, attachments);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    save(next);
  }, [clearDraftTimer]);

  const setDraftLaunchOptions = useCallback((
    sessionId: string,
    update: DraftLaunchOptionsUpdate,
  ) => {
    clearDraftTimer(sessionId);
    setState((prev) => {
      const currentDraft = prev[sessionId] ?? { text: "" };
      const nextLaunch = typeof update === "function"
        ? update(currentDraft.launch)
        : update;
      const hasContent = currentDraft.text.trim().length > 0
        || (currentDraft.attachments?.length ?? 0) > 0;

      if (!hasContent && !nextLaunch) {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        stateRef.current = next;
        save(next);
        return next;
      }

      const nextDraft: Draft = {
        ...currentDraft,
        ...(nextLaunch ? { launch: nextLaunch } : {}),
      };
      if (!nextLaunch) delete nextDraft.launch;
      const next = { ...prev, [sessionId]: nextDraft };
      stateRef.current = next;
      save(next);
      return next;
    });
  }, [clearDraftTimer]);

  const clearDraft = useCallback((sessionId: string) => {
    clearDraftTimer(sessionId);
    setState((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      stateRef.current = next;
      save(next);
      return next;
    });
  }, [clearDraftTimer]);

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((timer) => clearTimeout(timer));
      timersRef.current = {};
    };
  }, []);

  const getDraft = useCallback(
    (sessionId: string): Draft | null => {
      return state[sessionId] ?? null;
    },
    [state],
  );

  const hasDraft = useCallback(
    (sessionId: string): boolean => {
      return sessionId in state;
    },
    [state],
  );

  return {
    getDraft,
    setDraft,
    setDraftImmediate,
    setDraftLaunchOptions,
    clearDraft,
    hasDraft,
  };
}

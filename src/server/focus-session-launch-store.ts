import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import type { CopilotContextTier } from "../shared/copilot-context.js";
import type { ProcessIdentity } from "./platform.js";
import { FeedCardNotFoundError } from "./feed-store.js";

export type FocusLaunchSource = "launch_prompt" | "discussion";
export type FocusLaunchStatus = "prepared" | "creating" | "created" | "ready" | "failed" | "unknown" | "superseded";
export type FocusLaunchErrorStage = "creation" | "link" | "prompt";
export interface FocusLaunchIdentity { objectId: string; activationId: string; source: FocusLaunchSource }
export interface FocusSessionCreationOptions {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  agent?: string;
}
export interface FocusSessionLaunch extends FocusLaunchIdentity {
  id: string;
  objectType: "decision" | "alert" | "event";
  objectTitle: string;
  status: FocusLaunchStatus;
  taskId: string | null;
  taskTitle: string | null;
  prompt: string;
  promptFingerprint: string;
  creationOptions: FocusSessionCreationOptions;
  expectedSessionId: string;
  sessionId: string | null;
  promptStatus: "pending" | "sending" | "sent" | "unknown";
  creationDispatchedAt: string | null;
  linkedAt: string | null;
  promptDispatchedAt: string | null;
  error: string | null;
  errorStage: FocusLaunchErrorStage | null;
  ownerPid: number | null;
  ownerStartMarker: string | null;
  ownerToken: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class FocusLaunchConflictError extends Error {}

export const FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT = 25;
export interface FocusLaunchStartupRecoveryBatch {
  receipts: FocusSessionLaunch[];
  skippedPrepared: number;
  skippedInspectOnly: number;
  deferred: number;
}

const STARTUP_RECOVERY_FILTER = `status='created' AND sessionId IS NOT NULL AND sessionId<>'' AND sessionId=expectedSessionId
  AND promptStatus='pending' AND promptDispatchedAt IS NULL`;

export function isStartupRecoverableFocusLaunch(receipt: FocusSessionLaunch): boolean {
  return receipt.status === "created" && !!receipt.sessionId && receipt.sessionId === receipt.expectedSessionId
    && receipt.promptStatus === "pending" && receipt.promptDispatchedAt === null;
}

export function initializeFocusSessionLaunchSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS focus_session_launches (
      id TEXT PRIMARY KEY,
      objectId TEXT NOT NULL,
      activationId TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('launch_prompt','discussion')),
      objectType TEXT NOT NULL CHECK (objectType IN ('decision','alert','event')),
      objectTitle TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared','creating','created','ready','failed','unknown','superseded')),
      taskId TEXT,
      taskTitle TEXT,
      prompt TEXT NOT NULL,
      promptFingerprint TEXT NOT NULL,
      creationOptionsJson TEXT NOT NULL,
      expectedSessionId TEXT NOT NULL UNIQUE,
      sessionId TEXT,
      promptStatus TEXT NOT NULL DEFAULT 'pending' CHECK (promptStatus IN ('pending','sending','sent','unknown')),
      creationDispatchedAt TEXT,
      linkedAt TEXT,
      promptDispatchedAt TEXT,
      error TEXT,
      errorStage TEXT CHECK (errorStage IN ('creation','link','prompt')),
      ownerPid INTEGER,
      ownerStartMarker TEXT,
      ownerToken TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE (objectId, activationId, source)
    );
    CREATE INDEX IF NOT EXISTS idx_focus_launches_object ON focus_session_launches(objectId, activationId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_focus_launches_status ON focus_session_launches(status, updatedAt);
  `);
}

type LaunchRow = Omit<FocusSessionLaunch, "creationOptions"> & { creationOptionsJson: string };
function hydrate(row: LaunchRow): FocusSessionLaunch {
  const { creationOptionsJson, ...rest } = row;
  return { ...rest, creationOptions: JSON.parse(creationOptionsJson) as FocusSessionCreationOptions };
}
export function publicFocusSessionLaunch(receipt: FocusSessionLaunch) {
  const { ownerPid: _pid, ownerStartMarker: _marker, ownerToken: _token, ...rest } = receipt;
  return rest;
}
export type PublicFocusSessionLaunch = ReturnType<typeof publicFocusSessionLaunch>;

export function createFocusSessionLaunchStore(db: DatabaseSync) {
  function get(id: string): FocusSessionLaunch | undefined {
    const row = db.prepare("SELECT * FROM focus_session_launches WHERE id=?").get(id) as LaunchRow | undefined;
    return row ? hydrate(row) : undefined;
  }
  function requireReceipt(id: string): FocusSessionLaunch {
    const receipt = get(id);
    if (!receipt) throw new FeedCardNotFoundError(`Focus launch ${id} not found`);
    return receipt;
  }
  function find(identity: FocusLaunchIdentity): FocusSessionLaunch | undefined {
    const row = db.prepare("SELECT * FROM focus_session_launches WHERE objectId=? AND activationId=? AND source=?")
      .get(identity.objectId, identity.activationId, identity.source) as LaunchRow | undefined;
    return row ? hydrate(row) : undefined;
  }
  function list(objectId: string, activationId: string): FocusSessionLaunch[] {
    return (db.prepare("SELECT * FROM focus_session_launches WHERE objectId=? AND activationId=? ORDER BY source")
      .all(objectId, activationId) as unknown as LaunchRow[]).map(hydrate);
  }
  function getStartupRecoveryBatch(): FocusLaunchStartupRecoveryBatch {
    // Preparation is dialog state, not confirmation to launch. Even a claimed
    // creating row is inspect-only here: startup never creates a session.
    const counts = db.prepare(`SELECT
      COUNT(CASE WHEN ${STARTUP_RECOVERY_FILTER} THEN 1 END) AS eligible,
      COUNT(CASE WHEN status='prepared' THEN 1 END) AS skippedPrepared,
      COUNT(CASE WHEN status IN ('creating','failed','unknown')
        OR (status='created' AND NOT (${STARTUP_RECOVERY_FILTER})) THEN 1 END) AS skippedInspectOnly
      FROM focus_session_launches WHERE status IN ('prepared','creating','created','failed','unknown')`)
      .get() as { eligible: number; skippedPrepared: number; skippedInspectOnly: number };
    const receipts = (db.prepare(`SELECT * FROM focus_session_launches WHERE ${STARTUP_RECOVERY_FILTER}
      ORDER BY updatedAt, id LIMIT ?`).all(FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT) as unknown as LaunchRow[]).map(hydrate);
    return {
      receipts, skippedPrepared: counts.skippedPrepared, skippedInspectOnly: counts.skippedInspectOnly,
      deferred: Math.max(0, counts.eligible - receipts.length),
    };
  }
  function prepare(input: FocusLaunchIdentity & Pick<FocusSessionLaunch,
    "objectType" | "objectTitle" | "taskId" | "taskTitle" | "prompt" | "promptFingerprint" | "creationOptions"
  >): { receipt: FocusSessionLaunch; created: boolean } {
    return runImmediateTransaction(db, () => {
      const existing = find(input);
      if (existing) {
        if (existing.promptFingerprint !== input.promptFingerprint) {
          throw new FocusLaunchConflictError("This episode/source already has a launch with different prompt, destination or session options");
        }
        return { receipt: existing, created: false };
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // The receipt ID is also the stable, Bridge-owned expected session ID.
      db.prepare(`INSERT INTO focus_session_launches (
        id, objectId, activationId, source, objectType, objectTitle, status, taskId, taskTitle, prompt,
        promptFingerprint, creationOptionsJson, expectedSessionId, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.objectId, input.activationId, input.source, input.objectType, input.objectTitle,
        input.taskId, input.taskTitle, input.prompt, input.promptFingerprint, JSON.stringify(input.creationOptions), id, now, now,
      );
      return { receipt: requireReceipt(id), created: true };
    });
  }
  function claim(receipt: FocusSessionLaunch, owner: ProcessIdentity): FocusSessionLaunch | undefined {
    return runImmediateTransaction(db, () => {
      const token = crypto.randomUUID();
      const changed = db.prepare(`UPDATE focus_session_launches SET
        ownerPid=?, ownerStartMarker=?, ownerToken=?, status=CASE WHEN sessionId IS NULL THEN 'creating' ELSE 'created' END,
        error=NULL, errorStage=NULL, version=version+1, updatedAt=?
        WHERE id=? AND version=? AND ownerToken IS ? AND status NOT IN ('ready','superseded')`).run(
        owner.pid, owner.startMarker, token, new Date().toISOString(), receipt.id, receipt.version, receipt.ownerToken,
      );
      return changed.changes ? requireReceipt(receipt.id) : undefined;
    });
  }
  function updateClaim(
    id: string, token: string,
    updates: Partial<Pick<FocusSessionLaunch,
      "status" | "sessionId" | "promptStatus" | "creationDispatchedAt" | "linkedAt" | "promptDispatchedAt" | "error" | "errorStage"
    >>,
    release = false,
  ): FocusSessionLaunch {
    const columns = Object.keys(updates);
    const assignments = [...columns.map((key) => `${key}=?`), "version=version+1", "updatedAt=?"];
    if (release) assignments.push("ownerPid=NULL", "ownerStartMarker=NULL", "ownerToken=NULL");
    const changed = db.prepare(`UPDATE focus_session_launches SET ${assignments.join(",")}
      WHERE id=? AND ownerToken=?`).run(...Object.values(updates), new Date().toISOString(), id, token);
    if (!changed.changes) throw new FocusLaunchConflictError("Focus launch claim changed; reload its receipt");
    return requireReceipt(id);
  }
  function markDispatched(id: string, token: string): FocusSessionLaunch {
    const receipt = requireReceipt(id);
    if (receipt.creationDispatchedAt !== null) throw new FocusLaunchConflictError("Session creation was already dispatched; reconcile the expected session instead");
    return updateClaim(id, token, { creationDispatchedAt: new Date().toISOString() });
  }
  function markCreated(id: string, token: string, sessionId: string): FocusSessionLaunch {
    if (requireReceipt(id).expectedSessionId !== sessionId) throw new FocusLaunchConflictError("Backend returned a different session ID than the durable launch receipt");
    return updateClaim(id, token, { sessionId, status: "created" });
  }
  function markLinked(id: string, token: string): FocusSessionLaunch {
    return updateClaim(id, token, { linkedAt: new Date().toISOString() });
  }
  function claimPrompt(id: string, token: string): FocusSessionLaunch {
    const receipt = requireReceipt(id);
    if (receipt.promptStatus !== "pending") throw new FocusLaunchConflictError("The initial prompt was already dispatched; it must not be replayed");
    return updateClaim(id, token, { promptStatus: "sending", promptDispatchedAt: new Date().toISOString() });
  }
  function complete(id: string, token: string): FocusSessionLaunch {
    return updateClaim(id, token, { status: "ready", promptStatus: "sent", error: null, errorStage: null }, true);
  }
  function fail(id: string, token: string, status: "failed" | "unknown" | "superseded", stage: FocusLaunchErrorStage, error: string): FocusSessionLaunch {
    return updateClaim(id, token, {
      status, errorStage: stage, error,
      ...(stage === "prompt" && status === "unknown" ? { promptStatus: "unknown" as const } : {}),
    }, true);
  }
  return { get, requireReceipt, find, list, getStartupRecoveryBatch, prepare, claim, markDispatched, markCreated, markLinked, claimPrompt, complete, fail };
}

export type FocusSessionLaunchStore = ReturnType<typeof createFocusSessionLaunchStore>;

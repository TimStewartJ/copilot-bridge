// Durable markers for commands running in a session's attached shell, so a command cut off by
// the Bridge can be reported to the agent that started it. See background-commands.ts.

import type { DatabaseSync } from "./db.js";
import { runInOwnOrOuterTransaction } from "./db-transaction.js";
import type {
  BackgroundCommandStopCause,
  RunningBackgroundCommand,
  StoppedBackgroundCommand,
} from "./background-commands.js";

/** A loss nobody collected for this long belongs to a session that is no longer used. */
const STOPPED_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** Enough to recognize the command in a notice. The full text stays in the session's own history. */
const COMMAND_TEXT_MAX_CHARS = 200;

type MarkerRow = {
  sessionId: string;
  shellId: string;
  startedAt: string;
  description: string | null;
  command: string | null;
  stoppedAt: string | null;
  stoppedBy: string | null;
};

function toStopped(row: MarkerRow): StoppedBackgroundCommand & { sessionId: string } {
  return {
    sessionId: row.sessionId,
    shellId: row.shellId,
    startedAt: row.startedAt,
    ...(row.description ? { description: row.description } : {}),
    ...(row.command ? { command: row.command } : {}),
    stoppedAt: row.stoppedAt ?? row.startedAt,
    stoppedBy: row.stoppedBy === "restart" ? "restart" : "unloaded",
  };
}

export function createBackgroundCommandStore(db: DatabaseSync) {
  const insertRunning = db.prepare(`
    INSERT OR IGNORE INTO background_command_markers (sessionId, shellId, startedAt, description, command)
    VALUES (?, ?, ?, ?, ?)
  `);
  const selectRunning = db.prepare(
    "SELECT shellId, startedAt FROM background_command_markers WHERE sessionId = ? AND stoppedAt IS NULL",
  );
  const deleteMarker = db.prepare(
    "DELETE FROM background_command_markers WHERE sessionId = ? AND shellId = ? AND startedAt = ? AND stoppedAt IS NULL",
  );
  const stopForSession = db.prepare(`
    UPDATE background_command_markers SET stoppedAt = ?, stoppedBy = ?
    WHERE sessionId = ? AND stoppedAt IS NULL
  `);
  const selectAllRunning = db.prepare(
    "SELECT * FROM background_command_markers WHERE stoppedAt IS NULL ORDER BY sessionId, startedAt",
  );
  const stopAll = db.prepare(
    "UPDATE background_command_markers SET stoppedAt = ?, stoppedBy = ? WHERE stoppedAt IS NULL",
  );
  const selectStopped = db.prepare(`
    SELECT * FROM background_command_markers
    WHERE sessionId = ? AND stoppedAt IS NOT NULL
    ORDER BY startedAt
  `);
  const deleteStopped = db.prepare(
    "DELETE FROM background_command_markers WHERE sessionId = ? AND shellId = ? AND startedAt = ? AND stoppedAt IS NOT NULL",
  );
  const deleteForSession = db.prepare("DELETE FROM background_command_markers WHERE sessionId = ?");
  const deleteStoppedBefore = db.prepare(
    "DELETE FROM background_command_markers WHERE stoppedAt IS NOT NULL AND stoppedAt < ?",
  );

  return {
    /**
     * Replaces what is known to be running in a loaded session. A command that left the list
     * finished or was stopped by its agent, which the runtime reports itself, so its marker goes.
     */
    syncRunning(sessionId: string, commands: readonly RunningBackgroundCommand[]): void {
      runInOwnOrOuterTransaction(db, () => {
        const keep = new Set(commands.map((command) => `${command.shellId}\u0000${command.startedAt}`));
        for (const row of selectRunning.all(sessionId) as Array<{ shellId: string; startedAt: string }>) {
          if (!keep.has(`${row.shellId}\u0000${row.startedAt}`)) deleteMarker.run(sessionId, row.shellId, row.startedAt);
        }
        for (const command of commands) {
          insertRunning.run(
            sessionId,
            command.shellId,
            command.startedAt,
            command.description?.slice(0, COMMAND_TEXT_MAX_CHARS) ?? null,
            command.command?.slice(0, COMMAND_TEXT_MAX_CHARS) ?? null,
          );
        }
      });
    },

    /** The session's runtime handle is gone, and its running commands with it. Returns how many. */
    markSessionStopped(sessionId: string, cause: BackgroundCommandStopCause, at: Date = new Date()): number {
      return Number(stopForSession.run(at.toISOString(), cause, sessionId).changes);
    },

    /** Boot only: nothing is loaded yet, so every command still marked running was cut off. */
    markAllRunningStopped(
      cause: BackgroundCommandStopCause,
      at: Date = new Date(),
    ): Array<StoppedBackgroundCommand & { sessionId: string }> {
      return runInOwnOrOuterTransaction(db, () => {
        const stoppedAt = at.toISOString();
        const rows = selectAllRunning.all() as MarkerRow[];
        if (rows.length > 0) stopAll.run(stoppedAt, cause);
        return rows.map((row) => toStopped({ ...row, stoppedAt, stoppedBy: cause }));
      });
    },

    /** Stopped commands the session's agent has not been told about. */
    listStopped(sessionId: string): StoppedBackgroundCommand[] {
      return (selectStopped.all(sessionId) as MarkerRow[]).map((row) => {
        const { sessionId: _sessionId, ...command } = toStopped(row);
        return command;
      });
    },

    /** The agent was told about exactly these; anything stopped since stays for the next message. */
    clearStopped(sessionId: string, commands: readonly Pick<StoppedBackgroundCommand, "shellId" | "startedAt">[]): void {
      if (commands.length === 0) return;
      runInOwnOrOuterTransaction(db, () => {
        for (const command of commands) deleteStopped.run(sessionId, command.shellId, command.startedAt);
      });
    },

    forgetSession(sessionId: string): void {
      deleteForSession.run(sessionId);
    },

    pruneStopped(now: Date = new Date()): number {
      return Number(deleteStoppedBefore.run(new Date(now.getTime() - STOPPED_RETENTION_MS).toISOString()).changes);
    },
  };
}

export type BackgroundCommandStore = ReturnType<typeof createBackgroundCommandStore>;

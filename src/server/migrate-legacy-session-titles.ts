import type { SessionTitlesStore } from "./session-titles.js";
import type { SetSessionNameOptions } from "./session-name-rpc.js";

export interface LegacySessionTitleMigrationDeps {
  sessionTitles: SessionTitlesStore;
  hasSessionOnDisk(sessionId: string): boolean;
  readSessionNameFromWorkspace(sessionId: string): string | undefined;
  setSessionName(sessionId: string, name: string, opts?: SetSessionNameOptions): Promise<void>;
  invalidateSessionListCache(reason?: string): void;
  logger?: Pick<typeof console, "warn">;
}

export async function migrateLegacySessionTitles(deps: LegacySessionTitleMigrationDeps): Promise<void> {
  const legacyTitles = deps.sessionTitles.getAllTitles();
  const entries = Object.entries(legacyTitles);
  if (entries.length === 0) {
    deps.sessionTitles.dropLegacyTable();
    return;
  }

  let failures = 0;
  for (const [sessionId, title] of entries) {
    try {
      const existingName = deps.readSessionNameFromWorkspace(sessionId);
      if (!existingName && deps.hasSessionOnDisk(sessionId)) {
        await deps.setSessionName(sessionId, title, { emit: false });
      }
      deps.sessionTitles.deleteTitle(sessionId);
    } catch (error) {
      failures += 1;
      deps.logger?.warn(`[sdk] [${sessionId.slice(0, 8)}] Legacy title migration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures === 0 && Object.keys(deps.sessionTitles.getAllTitles()).length === 0) {
    deps.sessionTitles.dropLegacyTable();
  }
  deps.invalidateSessionListCache("session:title-migration");
}

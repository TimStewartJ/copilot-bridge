import type { DatabaseSync } from "./db.js";

export interface SkillUsage {
  skillName: string;
  useCount: number;
  lastUsedAt: string;
  lastSessionId?: string;
}

/** How often each skill was loaded through the runtime's skill tool, for Settings › Skills. */
export function createSkillUsageStore(db: DatabaseSync) {
  return {
    record(skillName: string, sessionId: string | undefined, at = new Date().toISOString()): void {
      const name = skillName.trim().slice(0, 120);
      if (!name) return;
      db.prepare(`
        INSERT INTO skill_usage (skillName, useCount, lastUsedAt, lastSessionId)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(skillName) DO UPDATE SET
          useCount = skill_usage.useCount + 1,
          lastUsedAt = excluded.lastUsedAt,
          lastSessionId = excluded.lastSessionId
      `).run(name, at, sessionId ?? null);
    },
    list(): SkillUsage[] {
      const rows = db.prepare("SELECT skillName, useCount, lastUsedAt, lastSessionId FROM skill_usage").all() as Array<{
        skillName: string; useCount: number; lastUsedAt: string; lastSessionId: string | null;
      }>;
      return rows.map((row) => ({
        skillName: row.skillName,
        useCount: row.useCount,
        lastUsedAt: row.lastUsedAt,
        ...(row.lastSessionId ? { lastSessionId: row.lastSessionId } : {}),
      }));
    },
  };
}

export type SkillUsageStore = ReturnType<typeof createSkillUsageStore>;

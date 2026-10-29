import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/is-record.js";

/**
 * When a chat's context budget last changed size through the Bridge, kept beside its session
 * state so it outlives the server process: a switch to another model, or a session handle with a
 * different experimental Fusion context limit. A routed chat's meter sets aside step windows from
 * before then (`SessionUsageMetrics.budgetChangedAt`).
 */
export const BRIDGE_CONTEXT_BUDGET_FILE = "bridge-context-budget.json";

export interface ContextBudgetRecord {
  /** The Fusion context limit the chat's latest session handle came with; unset is the runtime's own. */
  fusionContextTokens?: number;
  /** ISO time the budget last changed size. */
  changedAt?: string;
}

export function readContextBudget(sessionStateDir: string): ContextBudgetRecord {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(sessionStateDir, BRIDGE_CONTEXT_BUDGET_FILE), "utf8"));
    if (!isRecord(raw)) return {};
    return {
      ...(typeof raw.fusionContextTokens === "number" ? { fusionContextTokens: raw.fusionContextTokens } : {}),
      ...(typeof raw.changedAt === "string" && raw.changedAt ? { changedAt: raw.changedAt } : {}),
    };
  } catch {
    return {};
  }
}

function writeContextBudget(sessionStateDir: string, record: ContextBudgetRecord): void {
  mkdirSync(sessionStateDir, { recursive: true });
  const target = join(sessionStateDir, BRIDGE_CONTEXT_BUDGET_FILE);
  const tmp = join(sessionStateDir, `.${BRIDGE_CONTEXT_BUDGET_FILE}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, target);
}

/** Notes a switch to another model. */
export function recordModelChange(sessionStateDir: string, at: Date): void {
  writeContextBudget(sessionStateDir, { ...readContextBudget(sessionStateDir), changedAt: at.toISOString() });
}

/** Notes the Fusion context limit a new session handle came with; a different one changes the budget. */
export function recordFusionContextLimit(sessionStateDir: string, tokens: number | undefined, at: Date): void {
  const record = readContextBudget(sessionStateDir);
  if (record.fusionContextTokens === tokens) return;
  writeContextBudget(sessionStateDir, {
    ...(tokens === undefined ? {} : { fusionContextTokens: tokens }),
    changedAt: at.toISOString(),
  });
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/is-record.js";

/** When the chat's context budget last changed size; meters skip step windows before it. */
export const BRIDGE_CONTEXT_BUDGET_FILE = "bridge-context-budget.json";

export interface ContextBudgetRecord {
  /** Fusion context limit of the chat's latest session handle; unset means the runtime's own. */
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

/** Records a new session handle's Fusion context limit; a different one changes the budget. */
export function recordFusionContextLimit(sessionStateDir: string, tokens: number | undefined, at: Date): void {
  const record = readContextBudget(sessionStateDir);
  if (record.fusionContextTokens === tokens) return;
  writeContextBudget(sessionStateDir, {
    ...(tokens === undefined ? {} : { fusionContextTokens: tokens }),
    changedAt: at.toISOString(),
  });
}

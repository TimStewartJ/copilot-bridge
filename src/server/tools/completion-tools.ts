import type { AppContext } from "../app-context.js";
import { toolFailure } from "../tool-results.js";
import { defineSessionBridgeTool, registerBridgeToolDefinitions } from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { MAX_TASK_HISTORY_TEXT_LENGTH } from "../task-history-store.js";
import type { TaskChangeActor } from "../task-store.js";
import {
  COMPLETION_LIMITS,
  COMPLETION_TOOL_NAME,
  EVIDENCE_RESULTS,
  deriveCompletionStatus,
  readCompletionInput,
  type CompletionReport,
} from "../../shared/completion-report.js";
import {
  EVIDENCE_KINDS,
  EVIDENCE_KIND_DESCRIPTIONS,
  NO_PLAYBOOK,
  isPlaybookName,
} from "../../shared/workflow-vocabulary.js";

export interface RegisterCompletionToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

function agentActor(ctx: AppContext, sessionId: string): TaskChangeActor {
  const meta = ctx.sessionMetaStore?.getMeta(sessionId);
  return {
    source: "agent",
    sessionId,
    ...(meta?.scheduleId ? { scheduleId: meta.scheduleId } : {}),
    ...(meta?.scheduleName ? { scheduleName: meta.scheduleName } : {}),
  };
}

/** One line for the task history, then one line per check while they fit. */
export function formatCompletionHistoryEntry(report: Pick<CompletionReport, "status" | "playbookLabel" | "playbook" | "summary" | "evidence" | "unverified"> & { notes?: string[] }): string {
  const header = `Verified (${report.status}) ${report.playbookLabel ?? report.playbook ?? "work"}: ${report.summary}`;
  const lines = [header];
  let length = header.length;
  const details = [
    ...report.evidence.map((item) => `- ${item.kind}: ${item.result}${item.ref ? `, ${item.ref}` : ""}`),
    ...(report.unverified.length > 0 ? [`- not checked: ${report.unverified.join("; ")}`] : []),
    ...(report.notes?.length ? [`- notes: ${report.notes.join("; ")}`] : []),
  ];
  for (const line of details) {
    const room = MAX_TASK_HISTORY_TEXT_LENGTH - length - 1;
    if (room <= 0) break;
    const fitted = line.length <= room ? line : `${line.slice(0, Math.max(0, room - 1))}…`;
    lines.push(fitted);
    length += fitted.length + 1;
    if (fitted !== line) break;
  }
  return lines.join("\n");
}

export function createCompletionToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineSessionBridgeTool(COMPLETION_TOOL_NAME, {
      description:
        "Record that work is done, with evidence from the real system. Call it when a playbook's steps are finished, or when substantial direct-path work is. " +
        "Each evidence item gives its kind, what was checked, a reference (URL, command, file, run id) and the result. " +
        "A call missing the playbook's required evidence kinds is rejected. " +
        "An item's result says whether the check supports the work you are reporting: for `reproduced`, pass means the defect was reproduced. A premise you checked and found false (for example a build that has not passed) is a pass item whose claim states what you found; use fail only when your own work failed a check. " +
        "Mark an in-scope check you could not run honestly: result \"not_run\", or list it in unverified; either makes the report partial. Caveats outside what was asked (not pushed, no pull request, other platforms) go in notes, which never change the status. " +
        "Every claim must point to something that happened in this chat or on the real system. " +
        "The chat shows the report as a card; still tell the user the outcome. For delegated work, return the evidence to the parent instead.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: COMPLETION_LIMITS.summary, description: "What was done, in one or two sentences." },
          playbook: { type: "string", description: "Playbook the work followed. Defaults to the chat's active playbook." },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: COMPLETION_LIMITS.evidenceItems,
            description: "The checks that show the work is done.",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...EVIDENCE_KINDS], description: "Kind of evidence." },
                claim: { type: "string", minLength: 1, maxLength: COMPLETION_LIMITS.claim, description: "What was checked and what it showed." },
                ref: { type: "string", maxLength: COMPLETION_LIMITS.ref, description: "Where to see it: URL, command, file path, run or commit id." },
                result: { type: "string", enum: [...EVIDENCE_RESULTS], description: "pass when the check supports the work you report (a reproduced bug is pass), fail when your work failed it, not_run when it could not run." },
              },
              required: ["kind", "claim", "result"],
            },
          },
          unverified: {
            type: "array",
            maxItems: COMPLETION_LIMITS.unverifiedItems,
            description: "Checks within what was asked that you could not run. Each one makes the report partial.",
            items: { type: "string", maxLength: COMPLETION_LIMITS.unverifiedItem },
          },
          notes: {
            type: "array",
            maxItems: COMPLETION_LIMITS.notesItems,
            description: "Caveats outside what was asked, such as not pushed or no pull request opened. Shown on the card; they do not change its status.",
            items: { type: "string", maxLength: COMPLETION_LIMITS.noteItem },
          },
        },
        required: ["summary", "evidence"],
      },
      handler: async (args: any, invocation) => {
        if (invocation.agentId) return toolFailure("No chat report was recorded. Return your findings and evidence to the parent agent instead.");
        const input = readCompletionInput(args);
        if (!input.ok) return toolFailure(input.error);
        const sessionId = invocation.sessionId;
        const catalog = ctx.skillCatalog;

        let playbookName: string | undefined;
        if (input.value.playbook !== undefined && input.value.playbook !== NO_PLAYBOOK) {
          if (!isPlaybookName(input.value.playbook) || !catalog?.findPlaybook(input.value.playbook)) {
            const installed = catalog?.playbooks().map((candidate) => candidate.id).sort().join(", ");
            return toolFailure(`"${input.value.playbook}" is not an installed playbook.${installed ? ` Installed: ${installed}.` : ""}`);
          }
          playbookName = input.value.playbook;
        }
        const active = input.value.playbook === undefined ? ctx.sessionManager.getSessionPlaybook?.(sessionId) : undefined;
        if (active?.playbook && active.playbook !== NO_PLAYBOOK) playbookName = active.playbook;
        const playbook = playbookName ? catalog?.findPlaybook(playbookName) : undefined;
        const playbookLabel = playbook?.label ?? active?.label ?? playbookName;

        const present = new Set(input.value.evidence.map((item) => item.kind));
        const missing = (playbook?.evidence ?? []).filter((kind) => !present.has(kind));
        if (missing.length > 0) {
          const listed = missing.map((kind) => `${kind} (${EVIDENCE_KIND_DESCRIPTIONS[kind]})`).join(", ");
          return toolFailure(
            `${playbookLabel ?? playbookName} requires evidence that is missing: ${listed}. Nothing was recorded.`,
            {
              detail: "Gather that evidence and call verify_complete again. If you truly cannot, do not call verify_complete; tell the user what you could not check and why.",
            },
          );
        }

        const status = deriveCompletionStatus(input.value.evidence, input.value.unverified);
        const task = ctx.taskStore.findTaskBySessionId(sessionId);
        if (!ctx.completionReportStore) return toolFailure("Completion reports are not available.");
        const report = ctx.completionReportStore.add({
          sessionId,
          ...(task ? { taskId: task.id } : {}),
          ...(playbookName ? { playbook: playbookName } : {}),
          ...(playbookLabel ? { playbookLabel } : {}),
          status,
          summary: input.value.summary,
          evidence: input.value.evidence,
          unverified: input.value.unverified,
          notes: input.value.notes,
        });

        let historyEntryId: number | undefined;
        if (task && ctx.taskHistoryStore) {
          const entry = ctx.taskHistoryStore.addEntry(task.id, formatCompletionHistoryEntry(report), agentActor(ctx, sessionId));
          historyEntryId = entry.id;
          ctx.globalBus.emit({ type: "task:changed", taskId: task.id });
        }

        const word = status === "verified" ? "verified" : status === "partial" ? "partly verified" : "not verified (a check failed)";
        return {
          success: true,
          reportId: report.id,
          status,
          ...(playbookName ? { playbook: playbookName } : {}),
          ...(playbookLabel ? { playbookLabel } : {}),
          ...(historyEntryId !== undefined ? { historyEntryId } : {}),
          message: `Recorded as ${word}. The card is in the chat; tell the user the outcome${status === "verified" ? "" : " and what remains"}.`,
        };
      },
    }),
  ];
}

export function registerCompletionTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterCompletionToolsOptions = {},
): void {
  const definitions = createCompletionToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}

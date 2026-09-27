import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/is-record.js";
import type { ScheduleContext } from "./session-config-builder.js";
import { MAX_PREVIOUS_RUN_REPORT_LENGTH, type PreviousRunReport } from "./prompt-profiles.js";

const FILE_NAME = "bridge-launch-context.json";

export interface SessionLaunchContext {
  isNewTask?: boolean;
  scheduleContext?: Pick<ScheduleContext, "name" | "type" | "runCount" | "previousRunReport">;
}

function readPreviousRunReport(value: unknown): PreviousRunReport | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "running") return { status: "running" };
  if (value.status === "unavailable" && typeof value.reason === "string") return { status: "unavailable", reason: value.reason };
  if (value.status !== "completed" || typeof value.content !== "string") return undefined;
  return {
    status: "completed",
    content: value.content,
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
  };
}

/** Keeps the launch context small: the prompt renders at most this much of the report. */
function boundPreviousRunReport(report: PreviousRunReport): PreviousRunReport {
  if (report.status !== "completed") return report;
  return { ...report, content: report.content.slice(0, MAX_PREVIOUS_RUN_REPORT_LENGTH + 1) };
}

export function readSessionLaunchContext(directory: string): SessionLaunchContext {
  let text: string;
  try {
    text = readFileSync(join(directory, FILE_NAME), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || (value.isNewTask !== undefined && typeof value.isNewTask !== "boolean")) {
    throw new Error("Invalid Bridge session launch context");
  }
  const schedule = value.scheduleContext;
  if (schedule !== undefined && (
    !isRecord(schedule)
    || typeof schedule.name !== "string"
    || (schedule.type !== "cron" && schedule.type !== "once")
    || typeof schedule.runCount !== "number"
    || !Number.isSafeInteger(schedule.runCount)
    || schedule.runCount < 0
  )) throw new Error("Invalid Bridge session schedule launch context");
  return {
    ...(typeof value.isNewTask === "boolean" ? { isNewTask: value.isNewTask } : {}),
    ...(isRecord(schedule) ? {
      scheduleContext: {
        name: String(schedule.name),
        type: schedule.type === "cron" ? "cron" : "once",
        runCount: Number(schedule.runCount),
        ...(readPreviousRunReport(schedule.previousRunReport)
          ? { previousRunReport: readPreviousRunReport(schedule.previousRunReport) }
          : {}),
      },
    } : {}),
  };
}

export function writeSessionLaunchContext(directory: string, context: SessionLaunchContext): void {
  mkdirSync(directory, { recursive: true });
  const schedule = context.scheduleContext;
  const value: SessionLaunchContext = {
    isNewTask: context.isNewTask,
    ...(schedule ? {
      scheduleContext: {
        name: schedule.name,
        type: schedule.type,
        runCount: schedule.runCount,
        ...(schedule.previousRunReport ? { previousRunReport: boundPreviousRunReport(schedule.previousRunReport) } : {}),
      },
    } : {}),
  };
  const temporary = join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, join(directory, FILE_NAME));
}

import { describe, expect, it } from "vitest";
import type { TriggerView } from "../api";
import {
  buildTriggerCreate,
  buildTriggerUpdate,
  toDatetimeLocalValue,
  triggerFormState,
  type TriggerFormState,
} from "./trigger-form";

const NOW = new Date("2026-06-15T17:40:00.000Z");
const LATER = new Date("2026-06-20T09:30:00.000Z");

function form(overrides: Partial<TriggerFormState>): TriggerFormState {
  return { ...triggerFormState(null, { timezone: "UTC" }), prompt: "Check the build", ...overrides };
}

function existing(overrides: Partial<TriggerView>): TriggerView {
  return {
    id: "trigger-1",
    prompt: "Check the build",
    then: "new_chat",
    taskId: "task-1",
    when: { kind: "every", seconds: 3600 },
    whenLabel: "every 1 h",
    status: "active",
    runNow: false,
    runCount: 0,
    fireCount: 0,
    attempts: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    canRun: true,
    canPause: true,
    canResume: false,
    canCancel: true,
    canReactivate: false,
    ...overrides,
  };
}

describe("buildTriggerCreate", () => {
  it.each([
    ["once", { timing: "once" as const, runAt: toDatetimeLocalValue(LATER) }, { runAt: LATER.toISOString() }],
    ["every minutes", { timing: "every" as const, everyCount: "15", everyUnit: "minutes" as const }, { intervalSeconds: 900 }],
    ["every hours", { timing: "every" as const, everyCount: "2", everyUnit: "hours" as const }, { intervalSeconds: 7200 }],
    ["cron", { timing: "cron" as const, cron: " 0 9 * * 1 ", timezone: "Europe/Paris" }, { cron: "0 9 * * 1", timezone: "Europe/Paris" }],
  ])("sends exactly one timing for %s", (_name, overrides, timing) => {
    const result = buildTriggerCreate(form(overrides), "task-1", NOW);
    expect(result).toEqual({ ok: true, input: { prompt: "Check the build", then: "new_chat", taskId: "task-1", ...timing } });
  });

  it("sends the check one argument per line, and drops it for a one-time trigger", () => {
    const check = { checkEnabled: true, checkCommand: "gh\r\npr\n\n checks \n", checkCwd: " /repo ", checkFireOn: "exit_code" as const, checkTimeoutSeconds: "30" };
    expect(buildTriggerCreate(form({ timing: "every", everyCount: "5", everyUnit: "minutes", ...check }), "task-1", NOW)).toMatchObject({
      ok: true,
      input: { intervalSeconds: 300, check: { command: ["gh", "pr", "checks"], cwd: "/repo", timeoutSeconds: 30, fireOn: "exit_code" } },
    });
    const once = buildTriggerCreate(form({ timing: "once", runAt: toDatetimeLocalValue(LATER), ...check }), "task-1", NOW);
    expect(once.ok && once.input.check).toBeUndefined();
  });

  it("builds a task-creating trigger and requires its run limit", () => {
    const newTask = { then: "new_task" as const, title: " Weekly review ", keepChats: "3", timing: "cron" as const };
    expect(buildTriggerCreate(form(newTask), "task-1", NOW)).toEqual({ ok: false, error: expect.stringContaining("max runs") });
    expect(buildTriggerCreate(form({ ...newTask, maxRuns: "21" }), "task-1", NOW).ok).toBe(false);
    expect(buildTriggerCreate(form({ ...newTask, maxRuns: "4", modelTier: "preset2", playbook: "research" }), "task-1", NOW)).toEqual({
      ok: true,
      input: {
        prompt: "Check the build", then: "new_task", taskId: "task-1", title: "Weekly review",
        modelTier: "preset2", playbook: "research", cron: "0 8 * * 1-5", timezone: "UTC", maxRuns: 4,
      },
    });
  });

  it.each([
    ["an empty prompt", { prompt: " " }],
    ["a past run time", { timing: "once" as const, runAt: toDatetimeLocalValue(new Date(NOW.getTime() - 60_000)) }],
    ["a zero interval", { timing: "every" as const, everyCount: "0" }],
    ["a check with no command", { timing: "every" as const, checkEnabled: true, checkCommand: "\n" }],
    ["a past end date", { expiresAt: toDatetimeLocalValue(new Date(NOW.getTime() - 60_000)) }],
  ])("refuses %s", (_name, overrides) => {
    expect(buildTriggerCreate(form(overrides), "task-1", NOW).ok).toBe(false);
  });
});

describe("buildTriggerUpdate", () => {
  it("sends nothing when nothing changed, even for a one-time trigger whose time has passed", () => {
    const past = existing({ when: { kind: "at", at: "2026-06-01T08:00:00.000Z" }, whenLabel: "at 2026-06-01T08:00:00.000Z" });
    expect(buildTriggerUpdate(triggerFormState(past, { timezone: "UTC" }), past, NOW)).toEqual({ ok: true, input: {} });
    const checked = existing({
      check: { command: ["gh", "pr", "checks"], timeoutSeconds: 60, fireOn: "change", fireOnFirstRun: true },
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
    expect(buildTriggerUpdate(triggerFormState(checked, { timezone: "UTC" }), checked, NOW)).toEqual({ ok: true, input: {} });
  });

  it("sends only the changed fields, with null to clear", () => {
    const trigger = existing({
      name: "Build",
      modelTier: "preset1",
      maxRuns: 5,
      check: { command: ["gh"], timeoutSeconds: 60, fireOn: "change" },
    });
    const edited = {
      ...triggerFormState(trigger, { timezone: "UTC" }),
      timing: "cron" as const,
      cron: "0 9 * * *",
      modelTier: "" as const,
      maxRuns: "",
      checkEnabled: false,
    };
    expect(buildTriggerUpdate(edited, trigger, NOW)).toEqual({
      ok: true,
      input: { cron: "0 9 * * *", timezone: "UTC", modelTier: null, maxRuns: null, check: null },
    });
  });
});

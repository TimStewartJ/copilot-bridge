import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../db.js";
import { createDocsStore } from "../docs-store.js";
import { createGlobalBus } from "../global-bus.js";
import { createScheduleStore } from "../schedule-store.js";
import { createSettingsStore } from "../settings-store.js";
import { createTaskStore } from "../task-store.js";
import { ensureDemoWorkspace, resetDemoWorkspace } from "../demo-workspace.js";

describe("demo workspace", () => {
  const repoRoots: string[] = [];

  afterEach(() => {
    for (const repoRoot of repoRoots.splice(0)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("seeds isolated demo data, docs, schedules, and sandbox files", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bridge-demo-workspace-"));
    repoRoots.push(repoRoot);

    const workspace = resetDemoWorkspace(repoRoot);

    expect(workspace.dataDir).toBe(join(repoRoot, "demo-data"));
    expect(existsSync(join(workspace.workspaceDir, "README.md"))).toBe(true);
    expect(existsSync(join(workspace.workspaceDir, "src", "bridge-tour.ts"))).toBe(true);
    expect(existsSync(workspace.copilotHome)).toBe(true);

    const db = openDatabase(workspace.dataDir);
    try {
      const settingsStore = createSettingsStore(db);
      const taskStore = createTaskStore(db, createGlobalBus());
      const scheduleStore = createScheduleStore(db);
      const docsStore = createDocsStore(workspace.docsDir);

      expect(settingsStore.getSettings()).toMatchObject({
        theme: "dark",
        favicon: "emerald-bridge",
        reasoningEffort: "medium",
      });

      const startHere = taskStore.listTasks().find((task) => task.title === "Start Here - Copilot Bridge Tour");
      expect(startHere).toMatchObject({
        pinned: true,
        cwd: workspace.workspaceDir,
      });

      const followUp = scheduleStore.listSchedules().find((schedule) => schedule.name === "Demo follow-up prompt");
      expect(followUp).toBeDefined();
      expect(followUp?.type).toBe("once");
      expect(new Date(followUp!.runAt!).getTime()).toBeGreaterThan(Date.now());

      const startHereDoc = docsStore.readPage("showcase/start-here");
      expect(startHereDoc?.title).toBe("Start Here");
      expect(startHereDoc?.body).toContain("5-minute tour");

      const feedbackEntries = docsStore.listDbEntries("showcase/coworker-feedback");
      expect(feedbackEntries).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("refreshes the seeded one-shot schedule when reusing an old demo workspace", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bridge-demo-workspace-"));
    repoRoots.push(repoRoot);

    const workspace = resetDemoWorkspace(repoRoot);
    const db = openDatabase(workspace.dataDir);
    try {
      const scheduleStore = createScheduleStore(db);
      const followUp = scheduleStore.listSchedules().find((schedule) => schedule.name === "Demo follow-up prompt");
      expect(followUp).toBeDefined();

      scheduleStore.updateSchedule(followUp!.id, {
        enabled: true,
        runAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      });
    } finally {
      db.close();
    }

    const ensured = ensureDemoWorkspace(repoRoot);
    expect(ensured.reused).toBe(true);

    const refreshedDb = openDatabase(ensured.dataDir);
    try {
      const scheduleStore = createScheduleStore(refreshedDb);
      const followUp = scheduleStore.listSchedules().find((schedule) => schedule.name === "Demo follow-up prompt");
      expect(followUp?.enabled).toBe(true);
      expect(new Date(followUp!.runAt!).getTime()).toBeGreaterThan(Date.now());
    } finally {
      refreshedDb.close();
    }
  });
});

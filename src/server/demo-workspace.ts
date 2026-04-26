import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { openDatabase } from "./db.js";
import { createDocsIndex } from "./docs-index.js";
import { createDocsStore } from "./docs-store.js";
import { createGlobalBus } from "./global-bus.js";
import { createScheduleStore } from "./schedule-store.js";
import { createSettingsStore } from "./settings-store.js";
import { createTagStore, type TagColor } from "./tag-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createTaskStore } from "./task-store.js";
import { createChecklistStore } from "./checklist-store.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEMO_MARKER_FILENAME = "demo-seed.json";
const DEMO_WORKSPACE_DIRNAME = "workspace";
const DEMO_FOLLOW_UP_SCHEDULE_NAME = "Launch follow-up prompt";
const DEMO_FOLLOW_UP_SCHEDULE_PROMPT = "Ask what changed in the Acme launch plan today and turn the answer into a short checklist in this task.";
const DEMO_REVIEW_SCHEDULE_NAME = "Friday launch review";
const DEMO_REVIEW_SCHEDULE_PROMPT = "Review open Acme launch work. Summarize wins, risks, and next steps for the rollout.";

export const DEMO_DATA_DIRNAME = "demo-data";
export const DEMO_SEED_VERSION = 5;

export interface DemoPaths {
  dataDir: string;
  docsDir: string;
  markerPath: string;
  copilotHome: string;
  workspaceDir: string;
}

export interface DemoWorkspaceResult extends DemoPaths {
  reused: boolean;
  version: number;
}

interface DemoMarker {
  version: number;
  seededAt: string;
}

function readMarker(markerPath: string): DemoMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf-8")) as DemoMarker;
    return typeof raw.version === "number" ? raw : null;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string): void {
  writeFileSync(markerPath, JSON.stringify({
    version: DEMO_SEED_VERSION,
    seededAt: new Date().toISOString(),
  }, null, 2));
}

function dateOnly(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function timestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function markdownPage(title: string, tags: string[], body: string): string {
  return matter.stringify(`${body.trim()}\n`, { title, tags });
}

export function getDemoPaths(repoRoot: string): DemoPaths {
  const dataDir = join(repoRoot, DEMO_DATA_DIRNAME);
  return {
    dataDir,
    docsDir: join(dataDir, "docs"),
    markerPath: join(dataDir, DEMO_MARKER_FILENAME),
    copilotHome: join(dataDir, ".copilot"),
    workspaceDir: join(dataDir, DEMO_WORKSPACE_DIRNAME),
  };
}

function seedSandboxWorkspace(paths: DemoPaths): void {
  mkdirSync(paths.workspaceDir, { recursive: true });
  mkdirSync(join(paths.workspaceDir, "src"), { recursive: true });
  mkdirSync(paths.copilotHome, { recursive: true });

  writeFileSync(join(paths.workspaceDir, "README.md"), `# Acme sample workspace

This folder is a safe scratchpad for the seeded Acme launch workspace.

- edit files here without touching the live repository
- draft launch notes, support snippets, or rollout copy
- create throwaway files while exploring the task workflow
`);

  writeFileSync(join(paths.workspaceDir, "src", "acme-launch.ts"), `export const acmeLaunch = {
  product: "Acme Assist",
  launchWindow: "Next Friday",
  priorities: [
    "finish the launch brief",
    "capture a few rollout screenshots",
    "track questions from the pilot team",
  ],
  risks: [
    "support playbook still needs a final pass",
    "weekly review notes should stay in one thread",
  ],
};
`);
}

function createSeedTag(
  tagStore: ReturnType<typeof createTagStore>,
  name: string,
  color: TagColor,
  instructions: string,
) {
  const tag = tagStore.createTag(name, color);
  return tagStore.updateTag(tag.id, { instructions });
}

function addSeedChecklistItem(
  checklistStore: ReturnType<typeof createChecklistStore>,
  taskId: string | null,
  text: string,
  options: { done?: boolean; deadlineOffsetDays?: number } = {},
): void {
  const checklistItem = checklistStore.createChecklistItem(
    taskId,
    text,
    options.deadlineOffsetDays !== undefined ? dateOnly(options.deadlineOffsetDays) : undefined,
  );
  if (options.done) {
    checklistStore.updateChecklistItem(checklistItem.id, { done: true });
  }
}

function seedDocs(docsStore: ReturnType<typeof createDocsStore>): void {
  docsStore.writePage("index", markdownPage("Acme Launch Docs", ["launch"], `
# Acme launch docs

This workspace is seeded with a fictional Acme rollout so you can explore tasks, docs, schedules, and follow-up work without starting from a blank slate.

## Open these first

- [[acme/start-here]]
- [[acme/launch-plan]]
- [[acme/stakeholder-brief]]
- [[automation/browser-ideas]]
`));

  docsStore.writePage("acme/index", markdownPage("Acme Launch", ["launch", "docs"], `
# Acme Launch

This folder anchors the fictional rollout workspace used by the seeded demo.

## Suggested order

1. [[acme/start-here]]
2. [[acme/launch-plan]]
3. [[acme/stakeholder-brief]]
4. Browse the **Launch Notes** database collection
`));

  docsStore.writePage("acme/start-here", markdownPage("Start Here", ["launch", "docs"], `
# 5-minute tour

1. Open the ongoing **Start Here - Acme Launch Workspace** task.
2. Read the task note and check off a couple checklist items as you explore.
3. Start a task chat and paste one of the prompt ideas below.
4. Trigger the sample schedule on the task.
5. Add one entry to the **Launch Notes** collection in Docs.

## Prompt ideas

- "Summarize the Acme launch workspace and suggest the next three things to inspect."
- "Create a docs page called \`acme/release-qa\` with the questions the rollout team should answer before Friday."
- "Look at this task, its checklist, and its schedules, then explain how this workspace fits together."
- "Turn the launch plan into a short checklist for a Friday status review."
`));

  docsStore.writePage("acme/launch-plan", markdownPage("Launch Plan", ["launch", "docs"], `
# Launch plan

Acme is preparing a fictional rollout of **Acme Assist** to a small pilot group next Friday.

## Current priorities

- finalize the launch brief
- capture a few screenshots for the Friday review
- keep support handoff notes in one place
- turn open questions into trackable follow-up work
`));

  docsStore.writePage("acme/stakeholder-brief", markdownPage("Stakeholder Brief", ["launch"], `
# Stakeholder brief

Use this workspace to keep the launch thread compact:

- the ongoing task explains where to start
- checklist items make next actions easy to see
- schedules show how follow-up can stay attached to a task
- docs and database entries keep written context close to the work
`));

  docsStore.writePage("automation/index", markdownPage("Automation Lab", ["automation"], `
# Automation Lab

This folder captures ideas for where browser, web, and computer-use tools become useful inside the bridge.

Open [[automation/browser-ideas]] for a concrete example task.
`));

  docsStore.writePage("automation/browser-ideas", markdownPage("Browser Automation Ideas", ["automation"], `
# Browser automation ideas

Use this area to show that the bridge can reason across multiple browser layers:

- **web_search** for fast source discovery
- **browser_fetch** for rendered page verification
- **browser_exec** for structured browser actions
- **computer_open_browser** and computer tools for the heavy-duty fallback path

Good prompt: "Compare browser_fetch, browser_exec, and computer_open_browser, then recommend which one fits this task best."
`));

  docsStore.writeSchema("acme/launch-notes", {
    name: "Launch Notes",
    fields: [
      { name: "category", type: "select", options: ["risk", "question", "follow-up"], required: true },
      { name: "status", type: "select", options: ["new", "noted", "done"], required: true },
      { name: "owner", type: "text" },
    ],
  });

  docsStore.addDbEntry("acme/launch-notes", {
    title: "Support playbook still needs a final review",
    category: "risk",
    status: "noted",
    owner: "Support",
    tags: ["launch"],
  }, `
The canned response flow is drafted, but the escalation path still needs one more pass before Friday.
`);

  docsStore.addDbEntry("acme/launch-notes", {
    title: "Question about the Friday review cadence",
    category: "question",
    status: "new",
    owner: "Product",
    tags: ["launch"],
  }, `
Decide whether the weekly review should reuse the same task session or start fresh each time.
`);
}

function seedWorkspace(repoRoot: string): void {
  const paths = getDemoPaths(repoRoot);
  rmSync(paths.dataDir, { recursive: true, force: true });
  mkdirSync(paths.dataDir, { recursive: true });
  seedSandboxWorkspace(paths);
  const runtimePaths = resolveRuntimePaths({}, {
    demoMode: true,
    dataDir: paths.dataDir,
    docsDir: paths.docsDir,
    copilotHome: paths.copilotHome,
    workspaceDir: paths.workspaceDir,
  });

  const db = openDatabase(paths.dataDir);
  try {
    const bus = createGlobalBus();
    const taskStore = createTaskStore(db, bus, { runtimePaths });
    const taskGroupStore = createTaskGroupStore(db);
    const settingsStore = createSettingsStore(db);
    const scheduleStore = createScheduleStore(db);
    const checklistStore = createChecklistStore(db, bus);
    const tagStore = createTagStore(db);
    const docsStore = createDocsStore(paths.docsDir);

    settingsStore.updateSettings({
      theme: "dark",
      favicon: "emerald-bridge",
    });

    const launchGroup = taskGroupStore.createGroup("Acme Launch", "purple");
    taskGroupStore.updateGroup(launchGroup.id, {
      notes: "Sample launch-planning work for a fictional Acme rollout.",
    });

    const automationGroup = taskGroupStore.createGroup("Automation Lab", "cyan");
    taskGroupStore.updateGroup(automationGroup.id, {
      notes: "Experiments and prompt ideas around browser and desktop automation.",
    });

    const launchTag = createSeedTag(
      tagStore,
      "launch",
      "indigo",
      "Treat this workspace like a fictional rollout plan: keep summaries concrete, prioritize risks, and suggest next steps that help the launch move forward.",
    );
    const docsTag = createSeedTag(
      tagStore,
      "docs",
      "emerald",
      "When work touches notes or the knowledge base, prefer docs tools and keep content easy to scan.",
    );
    const automationTag = createSeedTag(
      tagStore,
      "automation",
      "cyan",
      "Prefer web_search and browser tools before escalating to computer-use, unless the site truly needs a visible browser.",
    );

    tagStore.setEntityTags("task_group", launchGroup.id, [launchTag.id]);
    tagStore.setEntityTags("task_group", automationGroup.id, [automationTag.id]);

    const createSeedTask = (title: string, groupId: string, updates: Parameters<typeof taskStore.updateTask>[1]) => {
      const task = taskStore.createTask(title, groupId);
      return taskStore.updateTask(task.id, updates);
    };

    const startHere = createSeedTask("Start Here - Acme Launch Workspace", launchGroup.id, {
      kind: "ongoing",
      cwd: paths.workspaceDir,
      notes: `
# Workspace goal

This seeded workspace is framed as a fictional Acme launch so you can explore the bridge with realistic sample data instead of a blank slate.

## Try this in order

1. Open the related docs for this task and read \`acme/start-here\`.
2. Check off a couple checklist items below as you explore.
3. Start a task session and paste one of the prompt ideas from the note or docs.
4. Trigger the **Launch follow-up prompt** schedule.
5. Open Docs and add one item to the **Launch Notes** collection.
6. If you edit files, keep them inside the sandbox workspace at \`demo-data/workspace\`.

## Prompt ideas

- "Summarize the Acme launch workspace and suggest the next three things to inspect."
- "Turn this task into a short launch-readiness walkthrough I could use in a status update."
- "Draft a short Friday update based on the current docs, checklist items, and schedules."
      `.trim(),
    });

    const launchReadiness = createSeedTask("Launch readiness sweep", launchGroup.id, {
      cwd: paths.workspaceDir,
      notes: `
# What this task is for

This task mirrors the last-mile cleanup before a fictional rollout.
Use the sandbox workspace for draft notes or sample edits so the live checkout stays untouched.

- tighten the launch brief
- capture screenshots for the Friday review
- make the support handoff easy to scan
- turn open questions into concrete follow-up work
      `.trim(),
    });

    const browserIdeas = createSeedTask("Browser automation ideas", automationGroup.id, {
      cwd: paths.workspaceDir,
      notes: `
# Prompt starter

Ask the agent to compare browser tool layers available in Copilot Bridge:

- web_search
- browser_fetch
- browser_exec
- browser_session_*
- computer_open_browser + computer tools

The goal is to show how the bridge can move from cheap source discovery to heavier browser control only when needed.
      `.trim(),
    });

    const backlog = createSeedTask("Future integrations backlog", automationGroup.id, {
      cwd: paths.workspaceDir,
      nextAction: "Review which vendor portals are worth automating next cycle",
      nextTouchAt: timestamp(7 * DAY_MS),
      notes: `
# Why this exists

This backlog task stays active but scheduled for later so it hints at future ideas without crowding the core launch flow.
      `.trim(),
    });

    taskStore.reorderTasks([startHere.id, launchReadiness.id, browserIdeas.id, backlog.id]);

    tagStore.setEntityTags("task", startHere.id, [docsTag.id]);
    tagStore.setEntityTags("task", launchReadiness.id, [docsTag.id]);

    addSeedChecklistItem(checklistStore, startHere.id, "Open the ongoing task and read the note", { done: true });
    addSeedChecklistItem(checklistStore, startHere.id, "Start one task chat and try a guided prompt", { deadlineOffsetDays: 1 });
    addSeedChecklistItem(checklistStore, startHere.id, "Trigger the sample schedule once", { deadlineOffsetDays: 1 });
    addSeedChecklistItem(checklistStore, startHere.id, "Add one launch-notes entry in Docs", { deadlineOffsetDays: 2 });

    addSeedChecklistItem(checklistStore, launchReadiness.id, "Draft a short leadership update", { deadlineOffsetDays: 2 });
    addSeedChecklistItem(checklistStore, launchReadiness.id, "Capture dashboard and workflow screenshots for Friday review", { deadlineOffsetDays: 2 });
    addSeedChecklistItem(checklistStore, launchReadiness.id, "Refine the stakeholder brief", { done: true });

    addSeedChecklistItem(checklistStore, browserIdeas.id, "Compare browser_exec with the browser skill", { deadlineOffsetDays: 4 });
    addSeedChecklistItem(checklistStore, browserIdeas.id, "Collect one web_search/browser_fetch example flow", { deadlineOffsetDays: 4 });
    addSeedChecklistItem(checklistStore, browserIdeas.id, "Decide where computer-use actually adds value", { done: true });

    addSeedChecklistItem(checklistStore, backlog.id, "Sketch vendor-auth onboarding for a future portal integration");
    addSeedChecklistItem(checklistStore, backlog.id, "Consider a sample dataset for provider cards later");

    addSeedChecklistItem(checklistStore, null, "Collect three screenshots for the launch brief", { deadlineOffsetDays: 1 });
    addSeedChecklistItem(checklistStore, null, "Write down open questions after the Friday review", { deadlineOffsetDays: 2 });
    addSeedChecklistItem(checklistStore, null, "Refresh the stakeholder brief", { done: true });

    scheduleStore.createSchedule({
      taskId: startHere.id,
      name: DEMO_FOLLOW_UP_SCHEDULE_NAME,
      prompt: DEMO_FOLLOW_UP_SCHEDULE_PROMPT,
      type: "once",
      runAt: timestamp(2 * HOUR_MS),
    });

    scheduleStore.createSchedule({
      taskId: launchReadiness.id,
      name: DEMO_REVIEW_SCHEDULE_NAME,
      prompt: DEMO_REVIEW_SCHEDULE_PROMPT,
      type: "cron",
      cron: "0 9 * * 5",
      sessionMode: "reuse-last",
    });

    seedDocs(docsStore);
    createDocsIndex(db, docsStore).reindex();
    writeMarker(paths.markerPath);
  } finally {
    db.close();
  }
}

function refreshSeededSchedules(repoRoot: string): void {
  const paths = getDemoPaths(repoRoot);
  const db = openDatabase(paths.dataDir);
  try {
    const settingsStore = createSettingsStore(db);
    const scheduleStore = createScheduleStore(db);
    const schedules = scheduleStore.listSchedules();
    if (settingsStore.getSettings().reasoningEffort !== undefined) {
      settingsStore.updateSettings({ reasoningEffort: undefined });
    }
    const demoFollowUp = schedules.find((schedule) =>
      schedule.type === "once"
      && schedule.name === DEMO_FOLLOW_UP_SCHEDULE_NAME
      && schedule.prompt === DEMO_FOLLOW_UP_SCHEDULE_PROMPT,
    );

    if (demoFollowUp && demoFollowUp.runCount === 0) {
      const runAt = demoFollowUp.runAt ? new Date(demoFollowUp.runAt).getTime() : Number.NaN;
      if (!Number.isFinite(runAt) || runAt <= Date.now()) {
        scheduleStore.updateSchedule(demoFollowUp.id, {
          enabled: true,
          runAt: timestamp(2 * HOUR_MS),
        });
      }
    }

    const demoReview = schedules.find((schedule) =>
      schedule.type === "cron"
      && schedule.name === DEMO_REVIEW_SCHEDULE_NAME
      && schedule.prompt === DEMO_REVIEW_SCHEDULE_PROMPT,
    );
    if (demoReview && demoReview.sessionMode !== "reuse-last") {
      scheduleStore.updateSchedule(demoReview.id, { sessionMode: "reuse-last" });
    }
  } finally {
    db.close();
  }
}

export function ensureDemoWorkspace(repoRoot: string): DemoWorkspaceResult {
  const paths = getDemoPaths(repoRoot);
  const marker = readMarker(paths.markerPath);
  const hasCurrentSeed = marker?.version === DEMO_SEED_VERSION
    && existsSync(join(paths.dataDir, "bridge.db"))
    && existsSync(paths.docsDir)
    && existsSync(paths.workspaceDir)
    && existsSync(paths.copilotHome);

  if (!hasCurrentSeed) {
    seedWorkspace(repoRoot);
    return { ...paths, reused: false, version: DEMO_SEED_VERSION };
  }

  refreshSeededSchedules(repoRoot);
  return { ...paths, reused: true, version: DEMO_SEED_VERSION };
}

export function resetDemoWorkspace(repoRoot: string): DemoWorkspaceResult {
  seedWorkspace(repoRoot);
  return { ...getDemoPaths(repoRoot), reused: false, version: DEMO_SEED_VERSION };
}

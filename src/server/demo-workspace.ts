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
import { createTodoStore } from "./todo-store.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEMO_MARKER_FILENAME = "demo-seed.json";
const DEMO_WORKSPACE_DIRNAME = "workspace";
const DEMO_FOLLOW_UP_SCHEDULE_NAME = "Demo follow-up prompt";
const DEMO_FOLLOW_UP_SCHEDULE_PROMPT = "Ask what stood out in the bridge demo and turn the answer into a short checklist in this task.";
const DEMO_REVIEW_SCHEDULE_NAME = "Friday bridge review";
const DEMO_REVIEW_SCHEDULE_PROMPT = "Review open polish work for Copilot Bridge. Summarize wins, risks, and next steps for a coworker-facing handoff.";

export const DEMO_DATA_DIRNAME = "demo-data";
export const DEMO_SEED_VERSION = 2;

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

  writeFileSync(join(paths.workspaceDir, "README.md"), `# Demo sandbox workspace

This folder is a safe scratchpad for the Copilot Bridge demo.

- edit files here without touching the live repository
- draft walkthrough notes or README copy
- create throwaway files while exploring the task workflow
`);

  writeFileSync(join(paths.workspaceDir, "src", "bridge-tour.ts"), `export const bridgeTour = {
  headline: "Tasks keep chat, docs, and follow-up work in one place.",
  pillars: [
    "persistent sessions tied to tasks",
    "docs and todos beside the conversation",
    "schedules and tags for follow-through",
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

function addSeedTodo(
  todoStore: ReturnType<typeof createTodoStore>,
  taskId: string | null,
  text: string,
  options: { done?: boolean; deadlineOffsetDays?: number } = {},
): void {
  const todo = todoStore.createTodo(
    taskId,
    text,
    options.deadlineOffsetDays !== undefined ? dateOnly(options.deadlineOffsetDays) : undefined,
  );
  if (options.done) {
    todoStore.updateTodo(todo.id, { done: true });
  }
}

function seedDocs(docsStore: ReturnType<typeof createDocsStore>): void {
  docsStore.writePage("index", markdownPage("Copilot Bridge Demo Docs", ["showcase"], `
# Copilot Bridge demo docs

This workspace is seeded so a coworker can understand the bridge without starting from a blank slate.

## Open these first

- [[showcase/start-here]]
- [[showcase/architecture]]
- [[showcase/pitch]]
- [[automation/browser-ideas]]
`));

  docsStore.writePage("showcase/index", markdownPage("Showcase", ["showcase", "docs"], `
# Showcase

This folder is the guided tour for the demo workspace.

## Suggested order

1. [[showcase/start-here]]
2. [[showcase/architecture]]
3. [[showcase/pitch]]
4. Browse the **Coworker Feedback** database collection
`));

  docsStore.writePage("showcase/start-here", markdownPage("Start Here", ["showcase", "docs"], `
# 5-minute tour

1. Open the pinned **Start Here - Copilot Bridge Tour** task.
2. Read the task note and check off a couple todos as you explore.
3. Start a task chat and paste one of the prompt ideas below.
4. Trigger the sample schedule on the task.
5. Add one entry to the **Coworker Feedback** collection in Docs.

## Prompt ideas

- "Summarize this workspace and suggest the next three things a coworker should click."
- "Create a docs page called \`showcase/feedback-summary\` with the questions teammates are likely to ask."
- "Look at this task, its todos, and its schedules, then explain how this workspace fits together."
- "Search the web for recent Copilot SDK changes and tell me if anything here should be revisited."
`));

  docsStore.writePage("showcase/architecture", markdownPage("Architecture at a Glance", ["showcase", "docs"], `
# Architecture at a glance

The bridge has three big pieces:

- A **launcher** that manages restart, rollback, and local deployment helpers
- An **Express server** with REST endpoints, SSE, the Copilot SDK session manager, and SQLite-backed stores
- A **React client** that brings together tasks, chats, docs, schedules, and settings

The point of the app is not just "chat with AI." It is to keep the surrounding work context close to the session: notes, todos, docs, and linked work all live beside the conversation.
`));

  docsStore.writePage("showcase/pitch", markdownPage("How to Explain the Bridge", ["showcase"], `
# How I explain the bridge

Copilot Bridge is a local AI workspace that treats **tasks** as the center of gravity instead of chats.

The pitch is:

- sessions are persistent
- tasks hold the working context
- docs live in the same place
- schedules and tags let the workspace stay organized
- the bridge can improve and preview itself safely
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

  docsStore.writeSchema("showcase/coworker-feedback", {
    name: "Coworker Feedback",
    fields: [
      { name: "category", type: "select", options: ["wow", "question", "follow-up"], required: true },
      { name: "status", type: "select", options: ["new", "noted", "actioned"], required: true },
      { name: "owner", type: "text" },
    ],
  });

  docsStore.addDbEntry("showcase/coworker-feedback", {
    title: "First-run reaction",
    category: "wow",
    status: "noted",
    owner: "Coworker",
    tags: ["showcase"],
  }, `
The task-centric layout makes it obvious that notes, docs, and chat belong together.
`);

  docsStore.addDbEntry("showcase/coworker-feedback", {
    title: "Question about schedules",
    category: "question",
    status: "new",
    owner: "Coworker",
    tags: ["showcase"],
  }, `
It would help to explain when a schedule reuses an existing session versus creating a new one.
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
    const todoStore = createTodoStore(db, bus);
    const tagStore = createTagStore(db);
    const docsStore = createDocsStore(paths.docsDir);

    settingsStore.updateSettings({
      theme: "dark",
      favicon: "emerald-bridge",
      reasoningEffort: "medium",
    });

    const showcaseGroup = taskGroupStore.createGroup("Showcase", "purple");
    taskGroupStore.updateGroup(showcaseGroup.id, {
      notes: "Guided tasks and docs for first-time coworkers seeing the bridge.",
    });

    const automationGroup = taskGroupStore.createGroup("Automation Lab", "cyan");
    taskGroupStore.updateGroup(automationGroup.id, {
      notes: "Experiments and prompt ideas around browser and desktop automation.",
    });

    const showcaseTag = createSeedTag(
      tagStore,
      "showcase",
      "indigo",
      "Frame responses so a coworker seeing the bridge for the first time can understand what matters quickly.",
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

    tagStore.setEntityTags("task_group", showcaseGroup.id, [showcaseTag.id]);
    tagStore.setEntityTags("task_group", automationGroup.id, [automationTag.id]);

    const createSeedTask = (title: string, groupId: string, updates: Parameters<typeof taskStore.updateTask>[1]) => {
      const task = taskStore.createTask(title, groupId);
      return taskStore.updateTask(task.id, updates);
    };

    const startHere = createSeedTask("Start Here - Copilot Bridge Tour", showcaseGroup.id, {
      pinned: true,
      cwd: paths.workspaceDir,
      notes: `
# Demo goal

This is the best place to start if you're seeing the bridge for the first time.

## Try this in order

1. Open the related docs for this task and read \`showcase/start-here\`.
2. Check off a couple todos below as you explore.
3. Start a task session and paste one of the prompt ideas from the note or docs.
4. Trigger the **Demo follow-up prompt** schedule.
5. Open Docs and add one item to the **Coworker Feedback** collection.
6. If you edit files, keep them inside the sandbox workspace at \`demo-data/workspace\`.

## Prompt ideas

- "Summarize this workspace for a coworker and suggest the next three clicks."
- "Turn this demo task into a quick walkthrough script I could use while screen sharing."
- "Search the web for recent Copilot SDK changes that might matter for this repo."
      `.trim(),
    });

    const coworkerPolish = createSeedTask("Coworker demo polish", showcaseGroup.id, {
      cwd: paths.workspaceDir,
      notes: `
# What this task is for

This task mirrors the polish work needed before sharing the repo around.
Use the sandbox workspace for draft notes or sample edits so the live checkout stays untouched.

- tighten the README
- capture screenshots or a Loom
- make the first-run experience obvious
- turn feedback into concrete follow-up work
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
      status: "paused",
      notes: `
# Why this exists

This paused task is here to make the workspace feel lived-in. It hints at future ideas without crowding the main demo flow.
      `.trim(),
    });

    taskStore.reorderTasks([startHere.id, coworkerPolish.id, browserIdeas.id, backlog.id]);

    tagStore.setEntityTags("task", startHere.id, [docsTag.id]);
    tagStore.setEntityTags("task", coworkerPolish.id, [docsTag.id]);

    addSeedTodo(todoStore, startHere.id, "Open the pinned task and read the note", { done: true });
    addSeedTodo(todoStore, startHere.id, "Start one task chat and try a guided prompt", { deadlineOffsetDays: 1 });
    addSeedTodo(todoStore, startHere.id, "Trigger the sample schedule once", { deadlineOffsetDays: 1 });
    addSeedTodo(todoStore, startHere.id, "Add one coworker-feedback entry in Docs", { deadlineOffsetDays: 2 });

    addSeedTodo(todoStore, coworkerPolish.id, "Record a 30-60 second Loom", { deadlineOffsetDays: 2 });
    addSeedTodo(todoStore, coworkerPolish.id, "Capture dashboard, task, and chat screenshots", { deadlineOffsetDays: 2 });
    addSeedTodo(todoStore, coworkerPolish.id, "Refine README onboarding copy", { done: true });

    addSeedTodo(todoStore, browserIdeas.id, "Compare browser_exec with the browser skill", { deadlineOffsetDays: 4 });
    addSeedTodo(todoStore, browserIdeas.id, "Collect one web_search/browser_fetch example flow", { deadlineOffsetDays: 4 });
    addSeedTodo(todoStore, browserIdeas.id, "Decide where computer-use actually adds value", { done: true });

    addSeedTodo(todoStore, backlog.id, "Sketch provider-auth onboarding for future polish");
    addSeedTodo(todoStore, backlog.id, "Consider a demo dataset for provider cards later");

    addSeedTodo(todoStore, null, "Collect three screenshots for the README", { deadlineOffsetDays: 1 });
    addSeedTodo(todoStore, null, "Write down coworker questions after the demo", { deadlineOffsetDays: 2 });
    addSeedTodo(todoStore, null, "Refresh the showcase README copy", { done: true });

    scheduleStore.createSchedule({
      taskId: startHere.id,
      name: DEMO_FOLLOW_UP_SCHEDULE_NAME,
      prompt: DEMO_FOLLOW_UP_SCHEDULE_PROMPT,
      type: "once",
      runAt: timestamp(2 * HOUR_MS),
    });

    scheduleStore.createSchedule({
      taskId: coworkerPolish.id,
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
    const scheduleStore = createScheduleStore(db);
    const schedules = scheduleStore.listSchedules();
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

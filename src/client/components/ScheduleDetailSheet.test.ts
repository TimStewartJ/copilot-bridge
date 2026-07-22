import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import { installDomShim } from "../test-dom-shim";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import type { Schedule, ScheduleRun } from "../api";

const apiMocks = vi.hoisted(() => ({
  createSchedule: vi.fn(),
  patchSchedule: vi.fn(),
  fetchServerTimezone: vi.fn(),
  getSessionRunState: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  useScheduleSessionsQuery: vi.fn(),
}));

const modelQueryMocks = vi.hoisted(() => ({
  useModelsQuery: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

vi.mock("../hooks/queries/useScheduleSessions", () => queryMocks);
vi.mock("../hooks/queries/useModels", () => modelQueryMocks);

const NOW = new Date("2026-06-15T17:40:30.000Z");

function toDatetimeLocalValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function findRunAtInput(harness: ReactDomHarness): any {
  const input = findAllByTag(harness.dom.container, "INPUT").find(
    (candidate) => getReactProps(candidate)?.type === "datetime-local",
  );
  if (!input) throw new Error("Run-at input not found");
  return input;
}

function findModelSelect(harness: ReactDomHarness): any {
  const select = findAllByTag(harness.dom.container, "SELECT").find(
    (candidate) => getReactProps(candidate)?.id === "schedule-model-select",
  );
  if (!select) throw new Error("Model select not found");
  return select;
}

function findButtonByText(harness: ReactDomHarness, text: string): any {
  const button = findAllByTag(harness.dom.container, "BUTTON").find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(harness: ReactDomHarness, text: string) {
  const button = findButtonByText(harness, text);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.({ stopPropagation() {} });
  });
}

async function setRunAt(harness: ReactDomHarness, value: string) {
  const input = findRunAtInput(harness);
  await harness.act(async () => {
    await getReactProps(input)?.onChange?.({ target: { value } });
  });
}

async function selectModel(harness: ReactDomHarness, value: string) {
  const select = findModelSelect(harness);
  await harness.act(async () => {
    await getReactProps(select)?.onChange?.({ target: { value } });
  });
}

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & {
    createElement: (tag: string) => any;
  };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () =>
          Array.from(element.childNodes ?? []).filter((child: any) => child.tagName === "OPTION"),
      });
    }
    if (normalizedTag === "OPTION") {
      Object.defineProperty(element, "value", {
        configurable: true,
        get: () => element.getAttribute("value") ?? element.textContent ?? "",
        set: (value) => element.setAttribute("value", String(value)),
      });
      Object.defineProperty(element, "selected", { configurable: true, writable: true, value: false });
    }
    return element;
  };

  return {
    container: dom.container,
    cleanup() {
      documentRef.createElement = originalCreateElement;
      dom.cleanup();
    },
  };
}

async function fillNameAndPrompt(harness: ReactDomHarness) {
  const nameInput = findAllByTag(harness.dom.container, "INPUT")[0];
  await harness.act(async () => {
    await getReactProps(nameInput)?.onChange?.({ target: { value: "Future run" } });
  });
  const textarea = findAllByTag(harness.dom.container, "TEXTAREA")[0];
  await harness.act(async () => {
    await getReactProps(textarea)?.onChange?.({ target: { value: "Do the thing" } });
  });
}

async function renderCreateSheet() {
  const onSaved = vi.fn();
  const noop = vi.fn();
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  await harness.render(
    createElement(ScheduleDetailSheet, {
      schedule: null,
      taskId: "task-1",
      mode: "create",
      onClose: noop,
      onSwitchToEdit: noop,
      onSwitchToView: noop,
      onTrigger: noop,
      onToggle: noop,
      onDelete: noop,
      onSaved,
    }),
  );
  // Switch to the one-time schedule mode.
  await clickButton(harness, "One-time");
  return { harness, onSaved };
}

function makeOnceSchedule(runAt: string): Schedule {
  return {
    id: "sched-1",
    taskId: "task-1",
    name: "Future run",
    prompt: "Do the thing",
    type: "once",
    runAt,
    enabled: true,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    runCount: 0,
  };
}

async function renderEditSheet(schedule: Schedule) {
  const onSaved = vi.fn();
  const noop = vi.fn();
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  await harness.render(
    createElement(ScheduleDetailSheet, {
      schedule,
      taskId: "task-1",
      mode: "edit",
      onClose: noop,
      onSwitchToEdit: noop,
      onSwitchToView: noop,
      onTrigger: noop,
      onToggle: noop,
      onDelete: noop,
      onSaved,
    }),
  );
  return { harness, onSaved };
}

function makeRecurringSchedule(): Schedule {
  return {
    id: "sched-1",
    taskId: "task-1",
    name: "Daily sync",
    prompt: "Sync the task",
    type: "cron",
    cron: "0 8 * * *",
    enabled: true,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    runCount: 21,
  };
}

function makeScheduleRun(runId: number, summary: string, runState: ScheduleRun["runState"] = "idle"): ScheduleRun {
  return {
    runId,
    sessionId: `session-${runId}`,
    summary,
    recordedAt: new Date(NOW.getTime() - runId * 60_000).toISOString(),
    recordedAtKnown: true,
    runState,
    busy: false,
    deferSummary: { count: 0, nextRunAt: null },
  };
}

async function renderViewSheet(schedule = makeRecurringSchedule()) {
  const noop = vi.fn();
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  const render = () => harness.render(
    createElement(ScheduleDetailSheet, {
      schedule,
      taskId: "task-1",
      mode: "view" as const,
      onClose: noop,
      onSwitchToEdit: noop,
      onSwitchToView: noop,
      onTrigger: noop,
      onToggle: noop,
      onDelete: noop,
      onSaved: noop,
    }),
  );
  await render();
  return {
    harness,
    rerender: render,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  apiMocks.createSchedule.mockReset();
  apiMocks.createSchedule.mockResolvedValue(undefined);
  apiMocks.patchSchedule.mockReset();
  apiMocks.patchSchedule.mockResolvedValue(undefined);
  apiMocks.fetchServerTimezone.mockReset();
  apiMocks.fetchServerTimezone.mockResolvedValue("UTC");
  apiMocks.getSessionRunState.mockReset();
  apiMocks.getSessionRunState.mockReturnValue("idle");
  queryMocks.useScheduleSessionsQuery.mockReset();
  queryMocks.useScheduleSessionsQuery.mockReturnValue({
    data: undefined,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  });
  modelQueryMocks.useModelsQuery.mockReset();
  modelQueryMocks.useModelsQuery.mockReturnValue({
    data: [
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ],
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ScheduleDetailSheet one-time run-at guard", () => {
  it("sets the run-at input min to the current minute", async () => {
    const { harness } = await renderCreateSheet();
    try {
      const input = findRunAtInput(harness);
      expect(getReactProps(input)?.min).toBe(toDatetimeLocalValue(NOW));
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a past run-at with an inline error and does not save", async () => {
    const { harness, onSaved } = await renderCreateSheet();
    try {
      await fillNameAndPrompt(harness);
      const past = toDatetimeLocalValue(new Date(NOW.getTime() - 24 * 60 * 60_000));
      await setRunAt(harness, past);

      await clickButton(harness, "Create Schedule");

      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Run time must be in the future"),
      );
      expect(apiMocks.createSchedule).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts a future run-at and creates the schedule", async () => {
    const { harness, onSaved } = await renderCreateSheet();
    try {
      await fillNameAndPrompt(harness);

      const future = toDatetimeLocalValue(new Date(NOW.getTime() + 24 * 60 * 60_000));
      await setRunAt(harness, future);
      await selectModel(harness, "claude-sonnet-5");

      await clickButton(harness, "Create Schedule");

      await waitUntilAct(harness.act, () => apiMocks.createSchedule.mock.calls.length > 0);
      expect(apiMocks.createSchedule).toHaveBeenCalledOnce();
      const input = apiMocks.createSchedule.mock.calls[0][0];
      expect(input.type).toBe("once");
      expect(input.runAt).toBe(new Date(future).toISOString());
      expect(input.model).toBe("claude-sonnet-5");
      expect(harness.dom.container.textContent ?? "").not.toContain("Run time must be in the future");
      await waitUntilAct(harness.act, () => onSaved.mock.calls.length > 0);
      expect(onSaved).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("ScheduleDetailSheet model override", () => {
  it("shows the selected model name in view mode", async () => {
    const { harness } = await renderViewSheet({
      ...makeRecurringSchedule(),
      model: "claude-sonnet-5",
    });
    try {
      expect(harness.dom.container.textContent).toContain("Claude Sonnet 5");
    } finally {
      await harness.cleanup();
    }
  });

  it("changes and clears the model override while editing", async () => {
    const { harness } = await renderEditSheet({
      ...makeRecurringSchedule(),
      model: "claude-sonnet-5",
    });
    try {
      expect(getReactProps(findModelSelect(harness))?.value).toBe("claude-sonnet-5");
      await selectModel(harness, "gpt-5.6-sol");
      await clickButton(harness, "Save Changes");
      await waitUntilAct(harness.act, () => apiMocks.patchSchedule.mock.calls.length > 0);
      expect(apiMocks.patchSchedule.mock.calls[0][1].model).toBe("gpt-5.6-sol");

      apiMocks.patchSchedule.mockClear();
      await selectModel(harness, "");
      await clickButton(harness, "Save Changes");
      await waitUntilAct(harness.act, () => apiMocks.patchSchedule.mock.calls.length > 0);
      expect(apiMocks.patchSchedule.mock.calls[0][1].model).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("ScheduleDetailSheet one-time run-at editing", () => {
  // Pin a non-UTC timezone so a naive UTC-string slice would visibly shift the
  // stored run time, proving the local-time conversion round-trips correctly.
  beforeEach(() => {
    vi.stubEnv("TZ", "America/New_York");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes the run-at input from the stored UTC time in local time", async () => {
    const runAt = "2026-06-20T13:30:00.000Z";
    const { harness } = await renderEditSheet(makeOnceSchedule(runAt));
    try {
      const value = getReactProps(findRunAtInput(harness))?.value;
      expect(value).toBe(toDatetimeLocalValue(new Date(runAt)));
      // A naive UTC slice would not match local time in this timezone.
      expect(value).not.toBe(runAt.slice(0, 16));
      // The displayed local value round-trips back to the original UTC instant.
      expect(new Date(value).toISOString()).toBe(runAt);
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves the stored UTC run time when saving an unchanged once-schedule", async () => {
    const runAt = "2026-06-20T13:30:00.000Z";
    const { harness, onSaved } = await renderEditSheet(makeOnceSchedule(runAt));
    try {
      await clickButton(harness, "Save Changes");

      await waitUntilAct(harness.act, () => apiMocks.patchSchedule.mock.calls.length > 0);
      expect(apiMocks.patchSchedule).toHaveBeenCalledOnce();
      const [id, patch] = apiMocks.patchSchedule.mock.calls[0];
      expect(id).toBe("sched-1");
      expect(patch.runAt).toBe(runAt);
      await waitUntilAct(harness.act, () => onSaved.mock.calls.length > 0);
      expect(onSaved).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("ScheduleDetailSheet run history pagination", () => {
  it("loads more runs and disables the control while the next page is loading", async () => {
    const fetchNextPage = vi.fn();
    queryMocks.useScheduleSessionsQuery.mockReturnValue({
      data: {
        pages: [{
          sessions: [makeScheduleRun(21, "Newest run")],
          total: 21,
          offset: 0,
          limit: 20,
        }],
        pageParams: [0],
      },
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: false,
    });

    const { harness, rerender } = await renderViewSheet();
    try {
      await clickButton(harness, "Load more");
      expect(fetchNextPage).toHaveBeenCalledOnce();

      queryMocks.useScheduleSessionsQuery.mockReturnValue({
        data: {
          pages: [{
            sessions: [makeScheduleRun(21, "Newest run")],
            total: 21,
            offset: 0,
            limit: 20,
          }],
          pageParams: [0],
        },
        fetchNextPage,
        hasNextPage: true,
        isFetchingNextPage: true,
      });
      await rerender();

      const loadingButton = findButtonByText(harness, "Loading...");
      expect(getReactProps(loadingButton)?.disabled).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("appends older pages in order without changing run status rendering", async () => {
    const newestRun = makeScheduleRun(21, "Newest run", "stalled");
    const olderRun = makeScheduleRun(1, "Older run");
    apiMocks.getSessionRunState.mockImplementation((session: ScheduleRun) => session.runState ?? "idle");
    queryMocks.useScheduleSessionsQuery.mockReturnValue({
      data: {
        pages: [
          {
            sessions: [newestRun],
            total: 2,
            offset: 0,
            limit: 20,
          },
          {
            sessions: [newestRun, olderRun],
            total: 2,
            offset: 1,
            limit: 20,
          },
        ],
        pageParams: [0, 1],
      },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    const { harness } = await renderViewSheet();
    try {
      const text = harness.dom.container.textContent ?? "";
      expect(text.indexOf("Newest run")).toBeLessThan(text.indexOf("Older run"));
      expect(text.match(/Newest run/g)).toHaveLength(1);
      expect(text).not.toContain("Load more");

      const newestButton = findAllByTag(harness.dom.container, "BUTTON").find(
        (button) => button.textContent?.includes("Newest run"),
      );
      const statusDot = findAllByTag(newestButton, "SPAN")[0];
      expect(getReactProps(statusDot)?.className).toContain("bg-warning animate-pulse");
    } finally {
      await harness.cleanup();
    }
  });
});

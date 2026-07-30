import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { installSelectAwareDomShim } from "../test-dom-shim";
import {
  createKeyEventDom,
  findDialogElements,
  resolveAccessibleName,
} from "../test-modal-dialog-dom";
import type { Schedule, Task, VisualArtifact } from "../api";
import DocPreviewSheet from "./DocPreviewSheet";
import FeedActionDialog from "./FeedActionDialog";
import NotesSheet from "./NotesSheet";
import PlanSheet from "./PlanSheet";
import ScheduleDetailSheet from "./ScheduleDetailSheet";
import SessionList from "./SessionList";
import TaskPickerDialog from "./TaskPickerDialog";
import ToolResultModal from "./ToolResultModal";
import VisualArtifactModal from "./VisualArtifactModal";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";

function makeTask(): Task {
  return {
    id: "task-1",
    title: "Workspace task",
    kind: "task",
    muted: false,
    status: "active",
    cwd: "/repo",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    tags: [],
  };
}

function makeSchedule(): Schedule {
  return {
    id: "sched-1",
    taskId: "task-1",
    name: "Daily sync",
    prompt: "Sync the task",
    type: "cron",
    cron: "0 8 * * *",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 3,
  };
}

function makeVisual(): VisualArtifact {
  return {
    artifactId: "artifact-1",
    kind: "image",
    title: "Diagram screenshot",
    displayName: "screenshot.png",
    mimeType: "image/png",
    size: 1024,
    url: "/artifacts/artifact-1",
    downloadUrl: "/artifacts/artifact-1?download=1",
  };
}

interface OverlayCase {
  name: string;
  accessibleName: string;
  element: (onClose: () => void) => ReactElement;
}

const overlayCases: OverlayCase[] = [
  {
    name: "PlanSheet",
    accessibleName: "Session Plan",
    element: (onClose) => createElement(PlanSheet, { sessionId: "session-1", onClose }),
  },
  {
    name: "ToolResultModal",
    accessibleName: "Tool output",
    element: (onClose) => createElement(ToolResultModal, {
      title: "Tool output",
      content: "result body",
      onClose,
    }),
  },
  {
    name: "NotesSheet",
    accessibleName: "Notes",
    element: (onClose) => createElement(NotesSheet, {
      notes: "Some notes",
      onSave: vi.fn(),
      onClose,
    }),
  },
  {
    name: "DocPreviewSheet",
    accessibleName: "areas/cooking/recipes",
    element: (onClose) => createElement(DocPreviewSheet, {
      docPath: "areas/cooking/recipes",
      onClose,
    }),
  },
  {
    name: "WorkspaceDetailsSheet",
    accessibleName: "Workspace details",
    element: (onClose) => createElement(WorkspaceDetailsSheet, {
      task: makeTask(),
      session: null,
      taskGitStatus: null,
      onClose,
    }),
  },
  {
    name: "ScheduleDetailSheet (view mode)",
    accessibleName: "Daily sync",
    element: (onClose) => createElement(ScheduleDetailSheet, {
      schedule: makeSchedule(),
      taskId: "task-1",
      mode: "view",
      onClose,
      onSwitchToEdit: vi.fn(),
      onSwitchToView: vi.fn(),
      onTrigger: vi.fn(),
      onToggle: vi.fn(),
      onDelete: vi.fn(),
      onSaved: vi.fn(),
    }),
  },
  {
    name: "TaskPickerDialog",
    accessibleName: "Link to Task",
    element: (onClose) => createElement(TaskPickerDialog, {
      tasks: [],
      onSelect: vi.fn(),
      onClose,
    }),
  },
  {
    name: "FeedActionDialog",
    accessibleName: "Run the audit",
    element: (onClose) => createElement(FeedActionDialog, {
      cardTitle: "Platform audit",
      actionLabel: "Run the audit",
      taskId: null,
      taskPreview: null,
      prompt: "Do the thing",
      error: null,
      submitting: false,
      submitMode: null,
      onPromptChange: vi.fn(),
      onClose,
      onStart: vi.fn(),
      onStartInBackground: vi.fn(),
    }),
  },
  {
    name: "VisualArtifactModal",
    accessibleName: "Diagram screenshot",
    element: (onClose) => createElement(VisualArtifactModal, { visual: makeVisual(), onClose }),
  },
];

function withProviders(children: ReactNode): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, null, children),
  );
}

async function renderOverlay(element: ReactElement) {
  const keyEventDom = createKeyEventDom({ baseInstall: installSelectAwareDomShim });
  const harness = await createReactDomHarness({ installDom: keyEventDom.installDom });
  await harness.render(withProviders(element));
  return {
    harness,
    pressEscape: async () => {
      await harness.act(async () => {
        keyEventDom.dispatchKeyDown("Escape");
      });
    },
  };
}

function clickButton(harness: ReactDomHarness, matcher: (props: any, node: any) => boolean) {
  const button = findAllByTag(harness.dom.container, "BUTTON").find(
    (candidate) => matcher(getReactProps(candidate) ?? {}, candidate),
  );
  if (!button) throw new Error("Button not found");
  return harness.act(async () => {
    await getReactProps(button)?.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });
}

beforeEach(() => {
  // Overlay data loads are irrelevant here; keep every request pending so each
  // sheet renders its stable loading/empty state.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Each overlay only needs to prove it wired the hook up to a real container and
// heading. Escape handling itself lives in the hook and is covered by
// useModalDialog.test.ts plus the custom dismiss-target cases below.
it.each(overlayCases)("$name exposes a named modal dialog", async ({ accessibleName, element }) => {
  const { harness } = await renderOverlay(element(vi.fn()));
  try {
    const dialogs = findDialogElements(harness.dom.container);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute("aria-modal")).toBe("true");
    expect(resolveAccessibleName(harness.dom.container, dialogs[0])).toBe(accessibleName);
  } finally {
    await harness.cleanup();
  }
});

describe("ScheduleDetailSheet stacked dialogs", () => {
  it("gives the delete confirmation its own dialog and lets Escape close only the topmost overlay", async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const { harness, pressEscape } = await renderOverlay(createElement(ScheduleDetailSheet, {
      schedule: makeSchedule(),
      taskId: "task-1",
      mode: "view",
      onClose,
      onSwitchToEdit: vi.fn(),
      onSwitchToView: vi.fn(),
      onTrigger: vi.fn(),
      onToggle: vi.fn(),
      onDelete,
      onSaved: vi.fn(),
    }));
    try {
      await clickButton(harness, (props) => props["aria-label"] === "More actions");
      await clickButton(harness, (_props, node) => node.textContent?.trim() === "Delete");

      const dialogs = findDialogElements(harness.dom.container);
      expect(dialogs).toHaveLength(2);
      expect(resolveAccessibleName(harness.dom.container, dialogs[1])).toBe("Delete schedule?");
      expect(dialogs[1].getAttribute("aria-modal")).toBe("true");

      await pressEscape();
      expect(onClose).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
      expect(findDialogElements(harness.dom.container)).toHaveLength(1);

      await pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("ScheduleDetailSheet dismiss target", () => {
  it("returns an existing schedule to view mode but closes outright while creating", async () => {
    const onClose = vi.fn();
    const onSwitchToView = vi.fn();
    const sheet = (mode: "edit" | "create") => createElement(ScheduleDetailSheet, {
      schedule: mode === "edit" ? makeSchedule() : null,
      taskId: "task-1",
      mode,
      onClose,
      onSwitchToEdit: vi.fn(),
      onSwitchToView,
      onTrigger: vi.fn(),
      onToggle: vi.fn(),
      onDelete: vi.fn(),
      onSaved: vi.fn(),
    });

    const { harness, pressEscape } = await renderOverlay(sheet("edit"));
    try {
      expect(resolveAccessibleName(
        harness.dom.container,
        findDialogElements(harness.dom.container)[0],
      )).toBe("Edit Schedule");
      await pressEscape();
      expect(onSwitchToView).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();

      await harness.render(withProviders(sheet("create")));
      await pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSwitchToView).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("FeedActionDialog dismissal guard", () => {
  it("ignores Escape while the prompt is submitting", async () => {
    const onClose = vi.fn();
    const { harness, pressEscape } = await renderOverlay(createElement(FeedActionDialog, {
      cardTitle: "Platform audit",
      actionLabel: "Run the audit",
      taskId: null,
      taskPreview: null,
      prompt: "Do the thing",
      error: null,
      submitting: true,
      submitMode: "foreground",
      onPromptChange: vi.fn(),
      onClose,
      onStart: vi.fn(),
      onStartInBackground: vi.fn(),
    }));
    try {
      await pressEscape();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("SessionList change-model dialog", () => {
  it("exposes modal semantics and closes on Escape", async () => {
    const keyEventDom = createKeyEventDom({ baseInstall: installSelectAwareDomShim });
    const harness = await createReactDomHarness({ installDom: keyEventDom.installDom });
    try {
      await harness.render(withProviders(createElement(SessionList, {
        variant: "global",
        sessions: [{
          sessionId: "session-1",
          summary: "Active session",
          deferSummary: { count: 0, nextRunAt: null },
        }],
        activeSessionId: null,
        onSelectSession: vi.fn(),
        onNewSession: vi.fn(),
        showNewButton: false,
      })));

      const sessionRow = findAllByTag(harness.dom.container, "BUTTON").find(
        (candidate) => typeof getReactProps(candidate)?.onContextMenu === "function",
      );
      if (!sessionRow) throw new Error("Session row not found");
      await harness.act(async () => {
        getReactProps(sessionRow)?.onContextMenu?.({
          preventDefault() {},
          clientX: 12,
          clientY: 24,
        });
      });

      await clickButton(harness, (_props, node) => node.textContent?.includes("Change Model") ?? false);

      const dialogs = findDialogElements(harness.dom.container);
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0].getAttribute("aria-modal")).toBe("true");
      expect(resolveAccessibleName(harness.dom.container, dialogs[0])).toBe("Change session model");

      await harness.act(async () => {
        keyEventDom.dispatchKeyDown("Escape");
      });
      expect(findDialogElements(harness.dom.container)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

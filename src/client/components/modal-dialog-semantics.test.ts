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
import { installDialogDom } from "../test-dialog-harness";
import {
  createKeyEventDom,
  findDialogElements,
  resolveAccessibleName,
} from "../test-modal-dialog-dom";
import type { Task, TriggerView, VisualArtifact } from "../api";
import PlanSheet from "./PlanSheet";
import SessionList from "./SessionList";
import TaskPickerDialog from "./TaskPickerDialog";
import ToolResultModal from "./ToolResultModal";
import TriggerDetailSheet from "./TriggerDetailSheet";
import TriggerSheet from "./TriggerSheet";
import VisualArtifactModal from "./VisualArtifactModal";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";

function makeTask(): Task {
  return {
    id: "task-1",
    title: "Workspace task",
    kind: "task",
    muted: false,
    deferred: false,
    status: "active",
    cwd: "/repo",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0",
    workItems: [],
    pullRequests: [],
    tags: [],
  };
}

function makeTrigger(): TriggerView {
  return {
    id: "trigger-1",
    name: "Daily sync",
    prompt: "Sync the task",
    then: "new_chat",
    taskId: "task-1",
    when: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" },
    whenLabel: "cron 0 8 * * * (UTC)",
    status: "active",
    runNow: false,
    runCount: 3,
    fireCount: 3,
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canRun: true,
    canPause: true,
    canResume: false,
    canCancel: true,
    canReactivate: false,
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
    name: "TaskPickerDialog",
    accessibleName: "Link to Task",
    element: (onClose) => createElement(TaskPickerDialog, {
      tasks: [],
      onSelect: vi.fn(),
      onClose,
    }),
  },
  {
    name: "TriggerSheet",
    accessibleName: "Triggers",
    element: (onClose) => createElement(TriggerSheet, { session: { sessionId: "session-1", summary: "Chat" }, onClose }),
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
  const keyEventDom = createKeyEventDom({ baseInstall: installDialogDom });
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
  // Keep every request pending so each sheet renders its stable loading/empty state.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Only proves the hook is wired; Escape handling is tested in useModalDialog.test.ts.
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

describe("TriggerDetailSheet dismiss target", () => {
  it("returns an existing trigger to view mode but closes outright while creating", async () => {
    const onClose = vi.fn();
    const onSwitchToView = vi.fn();
    const sheet = (mode: "edit" | "create") => createElement(TriggerDetailSheet, {
      trigger: mode === "edit" ? makeTrigger() : null,
      taskId: "task-1",
      mode,
      onClose,
      onSwitchToEdit: vi.fn(),
      onSwitchToView,
      onAction: vi.fn(),
      onSaved: vi.fn(),
    });

    const { harness, pressEscape } = await renderOverlay(sheet("edit"));
    try {
      expect(resolveAccessibleName(
        harness.dom.container,
        findDialogElements(harness.dom.container)[0],
      )).toBe("Edit trigger");
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
          triggerSummary: { count: 0, runningCount: 0, nextRunAt: null },
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
      expect(resolveAccessibleName(harness.dom.container, dialogs[0])).toBe("Change model");

      await harness.act(async () => {
        keyEventDom.dispatchKeyDown("Escape");
      });
      expect(findDialogElements(harness.dom.container)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WorkspaceDetailsSheet from "./WorkspaceDetailsSheet";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
} from "../test-react-harness";
import type { Task } from "../api";

describe("WorkspaceDetailsSheet copy path", () => {
  function createTask(): Task {
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

  async function renderSheet() {
    const harness = await createReactDomHarness();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await harness.render(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(WorkspaceDetailsSheet, {
        task: createTask(),
        session: null,
        taskGitStatus: null,
        onClose: () => {},
      }),
    ));

    return harness;
  }

  function clickCopyPath(root: any) {
    const button = findAllByTag(root, "BUTTON").find((candidate) => getReactProps(candidate)?.title === "Copy path");
    if (!button) throw new Error("Copy path button not found");
    getReactProps(button)?.onClick?.({ currentTarget: button, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  }

  function setClipboard(clipboard: unknown) {
    (globalThis.navigator as unknown as { clipboard?: unknown }).clipboard = clipboard;
  }

  function hasCopiedFlash(root: any): boolean {
    return findAllByTag(root, "svg")
      .some((icon) => (icon.getAttribute?.("class") ?? getReactProps(icon)?.className ?? "").includes("lucide-check"));
  }

  it("surfaces an inline error when the clipboard write rejects", async () => {
    const harness = await renderSheet();
    try {
      setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("Clipboard permission denied")) });

      await harness.act(async () => { clickCopyPath(harness.dom.container); });
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Failed to copy the workspace path"),
        { label: "workspace copy failure" },
      );
      expect(hasCopiedFlash(harness.dom.container)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});

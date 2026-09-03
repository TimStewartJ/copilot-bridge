import { createElement, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../test-react-harness";

const hookMocks = vi.hoisted(() => ({
  query: vi.fn(),
  cancel: vi.fn(),
  reactivate: vi.fn(),
}));

vi.mock("../hooks/queries/useSessionDefers", () => ({
  useSessionDefersQuery: () => hookMocks.query(),
  useCancelSessionDeferMutation: () => hookMocks.cancel(),
  useReactivateSessionDeferMutation: () => hookMocks.reactivate(),
}));

const { default: DeferredWorkSheet } = await import("./DeferredWorkSheet");

function buttonWithText(root: any, text: string) {
  return findAllByTag(root, "BUTTON").find((button) => button.textContent === text);
}

describe("DeferredWorkSheet", () => {
  it("renders active defers, recent defers, run receipts, and cancellation", async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    hookMocks.query.mockReturnValue({
      data: {
        sessionId: "session-1",
        defers: [
          {
            deferId: "interval_active",
            kind: "interval",
            name: "Build monitor",
            prompt: "Watch build 123",
            status: "active",
            nextRunAt: "2030-01-01T00:05:00.000Z",
            intervalSeconds: 1_200,
            runCount: 3,
            maxRuns: 10,
            attempts: 0,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
            canCancel: true,
            canReactivate: false,
          },
          {
            deferId: "once_failed",
            kind: "once",
            prompt: "Check once",
            status: "failed",
            nextRunAt: "2026-09-02T00:00:00.000Z",
            attempts: 5,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
            lastError: "Provider unavailable",
            canCancel: false,
            canReactivate: true,
          },
        ],
        recentRuns: [
          {
            id: 2,
            deferId: "once_failed",
            kind: "once",
            action: "error",
            durationMs: 1_500,
            completedAt: "2026-09-02T00:00:00.000Z",
            model: "small-model",
            error: "Provider unavailable",
          },
          {
            id: 1,
            deferId: "interval_active",
            kind: "interval",
            action: "continue",
            runCount: 3,
            durationMs: 900,
            completedAt: "2026-09-01T23:00:00.000Z",
            model: "small-model",
            reasoningEffort: "low",
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    hookMocks.cancel.mockReturnValue({ mutateAsync: cancel, isPending: false });
    hookMocks.reactivate.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    const harness = await createReactDomHarness();
    await harness.render(createElement(DeferredWorkSheet, {
      session: { sessionId: "session-1", summary: "Build session" },
      onClose: vi.fn(),
    }));

    expect(harness.dom.container.textContent).toContain("Deferred Work");
    expect(harness.dom.container.textContent).toContain("Build monitor");
    expect(harness.dom.container.textContent).toContain("Every 20m");
    expect(harness.dom.container.textContent).toContain("Provider unavailable");
    expect(harness.dom.container.textContent).toContain("Build monitor · Continued");
    expect(harness.dom.container.textContent).toContain("One-time defer · Failed");
    expect(buttonWithText(harness.dom.container, "Reactivate")).toBeDefined();
    const closeButton = findAllByTag(harness.dom.container, "BUTTON").find(
      (button) => getReactProps(button)?.title === "Close",
    );
    expect(globalThis.document.activeElement).toBe(closeButton);

    await harness.act(async () => {
      await getReactProps(buttonWithText(harness.dom.container, "Cancel"))?.onClick?.();
    });
    expect(cancel).toHaveBeenCalledWith("interval_active");
    await harness.cleanup();
  });

  it("restores focus to the stable opener when closed", async () => {
    hookMocks.query.mockReturnValue({
      data: { sessionId: "session-1", defers: [], recentRuns: [] },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    hookMocks.cancel.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hookMocks.reactivate.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    function Host() {
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLButtonElement>(null);
      return createElement(
        "div",
        null,
        createElement("button", {
          ref: openerRef,
          onClick: () => setOpen(true),
        }, "Open deferred work"),
        open
          ? createElement(DeferredWorkSheet, {
              session: { sessionId: "session-1", summary: "Session" },
              restoreFocusTo: openerRef.current,
              onClose: () => setOpen(false),
            })
          : null,
      );
    }

    const harness = await createReactDomHarness();
    await harness.render(createElement(Host));
    const opener = buttonWithText(harness.dom.container, "Open deferred work");
    await harness.act(async () => {
      getReactProps(opener)?.onClick?.();
    });
    const closeButton = findAllByTag(harness.dom.container, "BUTTON").find(
      (button) => getReactProps(button)?.title === "Close",
    );
    expect(globalThis.document.activeElement).toBe(closeButton);

    await harness.act(async () => {
      getReactProps(closeButton)?.onClick?.();
    });
    expect(globalThis.document.activeElement).toBe(opener);
    await harness.cleanup();
  });
});

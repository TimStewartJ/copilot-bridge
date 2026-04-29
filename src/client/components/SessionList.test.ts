import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../api";
import { installDomShim } from "../test-dom-shim";

async function renderSessionList(sessions: Session[]) {
  const dom = installDomShim();
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const [{ createRoot }, { act }, { default: SessionList }] = await Promise.all([
    import("react-dom/client"),
    import("react"),
    import("./SessionList"),
  ]);
  const root = createRoot(dom.container as unknown as Element);

  await act(async () => {
    root.render(createElement(SessionList, {
      variant: "global",
      sessions,
      activeSessionId: null,
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      showNewButton: false,
    }));
  });

  const cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    if (previousActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    dom.cleanup();
  };

  return { dom, cleanup };
}

describe("SessionList input-required indicator", () => {
  it("renders a needs-answer marker for sessions waiting on user input", async () => {
    const { dom, cleanup } = await renderSessionList([
      {
        sessionId: "session-1",
        summary: "Waiting session",
        runState: "busy",
        busy: true,
        pendingUserInputCount: 1,
        needsUserInput: true,
      },
    ]);

    try {
      expect(dom.container.textContent).toContain("Waiting session");
      expect(dom.container.textContent).toContain("Needs answer");
    } finally {
      await cleanup();
    }
  });
});

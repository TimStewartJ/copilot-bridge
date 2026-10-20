import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "./test-react-harness";
import { useReadState } from "./useReadState";

const fetchReadStateMock = vi.hoisted(() => vi.fn());

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchReadState: () => fetchReadStateMock(),
  };
});

const ACTIVITY_AT = "2026-09-30T10:00:00.000Z";

function Probe() {
  const { hydrated, isUnread } = useReadState();
  return createElement("output", null, `${hydrated}:${isUnread("session-1", ACTIVITY_AT)}`);
}

describe("useReadState", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    fetchReadStateMock.mockReset();
    await harness?.cleanup();
    harness = null;
  });

  it("reports hydration once the server's read state has replaced the all-unread default", async () => {
    let resolveReadState: ((state: Record<string, string>) => void) | undefined;
    fetchReadStateMock.mockReturnValue(new Promise((resolve) => {
      resolveReadState = resolve;
    }));
    harness = await createReactDomHarness();
    await harness.render(createElement(Probe));
    expect(harness.dom.container.textContent).toBe("false:true");

    await harness.act(async () => {
      resolveReadState?.({ "session-1": "2026-09-30T11:00:00.000Z" });
    });
    await waitUntilAct(harness.act, () => harness!.dom.container.textContent === "true:false");
  });

  it("stays unhydrated when the read state cannot be loaded", async () => {
    let rejectReadState: ((reason: Error) => void) | undefined;
    fetchReadStateMock.mockReturnValue(new Promise((_resolve, reject) => {
      rejectReadState = reject;
    }));
    harness = await createReactDomHarness();
    await harness.render(createElement(Probe));

    await harness.act(async () => {
      rejectReadState?.(new Error("read state unavailable"));
    });
    expect(harness.dom.container.textContent).toBe("false:true");
  });

  it.each(["Read store offline", ""])("exposes a load failure (%s) and clears it when read state recovers", async message => {
    fetchReadStateMock.mockRejectedValue(new Error(message));
    let reading: ReturnType<typeof useReadState>;
    function ErrorProbe() { reading = useReadState(); return null; }
    harness = await createReactDomHarness();
    await harness.render(createElement(ErrorProbe));
    await waitUntilAct(harness.act, () => reading.error !== null);
    expect(reading!.hydrated).toBe(false);
    expect(reading!.error).toBe(message || "Conversation read status is unavailable.");
    await harness.act(async () => { reading.applyServerState({ "session-1": ACTIVITY_AT }); });
    expect(reading!.hydrated).toBe(true);
    expect(reading!.error).toBeNull();
    expect(reading!.isUnread("session-1", ACTIVITY_AT)).toBe(false);
  });
});

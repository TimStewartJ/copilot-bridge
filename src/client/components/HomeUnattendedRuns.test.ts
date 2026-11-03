import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnattendedRun } from "../api";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";

const api = vi.hoisted(() => ({ fetchUnattendedRuns: vi.fn(), fetchSessions: vi.fn(), reviewUnattendedRun: vi.fn(),
  dismissUnattendedRun: vi.fn(), getSessionRunState: vi.fn() }));
vi.mock("../api", () => api);
import HomeUnattendedRuns from "./HomeUnattendedRuns";

const run = (sessionId: string, overrides: Partial<UnattendedRun> = {}): UnattendedRun => ({ sessionId, turnCount: 1,
  firstAt: "2026-09-22T08:00:00Z", lastAt: "2026-09-22T09:00:00Z", origins: ["schedule"], ...overrides });

describe("Ran while you were away", () => {
  let harness: DialogTestHarness;
  const selectSession = vi.fn();
  beforeEach(async () => { vi.resetAllMocks(); harness = await createDialogTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });
  const text = () => harness.dom.container.textContent ?? "";
  const buttons = (label: string) => findAllByTag(harness.dom.container, "BUTTON").filter(node => node.textContent?.trim() === label);
  async function click(button: unknown) {
    await harness.act(async () => { getReactProps(button)!.onClick({ preventDefault() {}, stopPropagation() {} }); await waitTick(); });
  }
  async function render(runs: UnattendedRun[]) {
    api.fetchUnattendedRuns.mockResolvedValue({ runs });
    api.fetchSessions.mockResolvedValue([{ sessionId: "named", summary: "Nightly build check" }]);
    await harness.render(createElement(HomeUnattendedRuns, { onSelectSession: selectSession }));
    await waitUntilAct(harness.act, () => text().includes("Ran while you were away"));
  }

  it("names each chat from the session list, then its task, and folds rows past five", async () => {
    await render([
      run("named", { taskId: "task-1", taskTitle: "Release prep", turnCount: 3, origins: ["defer", "schedule"] }),
      run("tasked", { taskTitle: "Inbox triage" }),
      run("titled", { title: "Renamed chat" }),
      run("bare"), run("five"), run("six"),
    ]);
    await waitUntilAct(harness.act, () => text().includes("Nightly build check"));
    expect(text()).toContain("Release prep");
    expect(text()).toContain("3 turns · defer, schedule");
    expect(text()).toContain("Inbox triage");
    expect(text()).toContain("Renamed chat");
    expect(buttons("Review")).toHaveLength(5);
    await click(buttons("1 more")[0]);
    expect(buttons("Review")).toHaveLength(6);
  });

  it("opens the chat after starting a review, shows the server's refusal, and dismisses at once", async () => {
    await render([run("first", { taskId: "task-1", title: "First chat" }), run("second", { title: "Second chat" })]);
    api.reviewUnattendedRun.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("This chat is busy."));
    await click(buttons("Review")[0]);
    expect(api.reviewUnattendedRun).toHaveBeenCalledWith("first");
    expect(selectSession).toHaveBeenCalledExactlyOnceWith("first", "task-1");
    await click(buttons("Review")[1]);
    await waitUntilAct(harness.act, () => text().includes("This chat is busy."));
    expect(selectSession).toHaveBeenCalledTimes(1);

    let finish!: () => void;
    api.dismissUnattendedRun.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await click(buttons("Dismiss")[1]);
    await waitUntilAct(harness.act, () => !text().includes("Second chat"));
    expect(api.dismissUnattendedRun).toHaveBeenCalledWith("second");
    api.fetchUnattendedRuns.mockResolvedValue({ runs: [run("first", { title: "First chat" })] });
    await harness.act(async () => { finish(); await waitTick(); });
  });
});

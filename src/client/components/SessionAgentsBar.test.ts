import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitTick,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import { installDomShim } from "../test-dom-shim";
import type {
  BackgroundAgentsSummary,
  SessionAgentDetailResponse,
  SessionAgentTask,
  SessionAgentsResponse,
} from "../api";
import { buildTranscriptAgentDirectory, type TranscriptAgent } from "../../shared/transcript-agents.js";
import SessionAgentsBar from "./SessionAgentsBar";

const fetchSessionAgents = vi.fn<(sessionId: string) => Promise<SessionAgentsResponse>>();
const fetchSessionAgentDetail = vi.fn<(sessionId: string, agentId: string) => Promise<SessionAgentDetailResponse>>();
const cancelSessionAgent = vi.fn<(sessionId: string, agentId: string) => Promise<{ cancelled: boolean }>>();
const dismissSessionAgent = vi.fn<(sessionId: string, agentId: string) => Promise<{ dismissed: true }>>();

vi.mock("../api", () => ({
  fetchSessionAgents: (sessionId: string) => fetchSessionAgents(sessionId),
  fetchSessionAgentDetail: (sessionId: string, agentId: string) => fetchSessionAgentDetail(sessionId, agentId),
  cancelSessionAgent: (sessionId: string, agentId: string) => cancelSessionAgent(sessionId, agentId),
  dismissSessionAgent: (sessionId: string, agentId: string) => dismissSessionAgent(sessionId, agentId),
}));

type BarProps = Parameters<typeof SessionAgentsBar>[0];

const BASE_MS = Date.parse("2026-10-01T12:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

beforeEach(() => {
  fetchSessionAgents.mockReset();
  fetchSessionAgentDetail.mockReset();
  cancelSessionAgent.mockReset();
  dismissSessionAgent.mockReset();
  // Reading an opened row in full is beside the point of most cases here.
  fetchSessionAgentDetail.mockRejectedValue(new Error("not under test"));
});

function liveSummary(partial: Partial<BackgroundAgentsSummary> = {}): BackgroundAgentsSummary {
  return { running: 1, idle: 0, failed: 0, total: 1, source: "live", ...partial };
}

function task(id: string, partial: Partial<SessionAgentTask> = {}): SessionAgentTask {
  return { id, status: "running", executionMode: "background", ...partial };
}

function listing(tasks: SessionAgentTask[], partial: Partial<SessionAgentsResponse> = {}): SessionAgentsResponse {
  return { tasks, source: "live", backgroundAgents: liveSummary(), ...partial };
}

function record(toolCallId: string, partial: Partial<TranscriptAgent> = {}): TranscriptAgent {
  return { toolCallId, name: toolCallId, status: "running", activeMs: 0, toolCount: 0, failedToolCount: 0, ...partial };
}

async function mount(props: BarProps, options: { phone?: boolean } = {}): Promise<ReactDomHarness> {
  const harness = await createReactDomHarness({
    installDom: () => {
      const dom = installDomShim();
      if (options.phone) {
        (globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
          matches: true,
          addEventListener() {},
          removeEventListener() {},
        });
      }
      return dom;
    },
  });
  await harness.render(createElement(SessionAgentsBar, props));
  return harness;
}

function text(harness: ReactDomHarness): string {
  return harness.dom.container.textContent ?? "";
}

function buttons(harness: ReactDomHarness): any[] {
  return findAllByTag(harness.dom.container, "BUTTON");
}

function buttonWith(harness: ReactDomHarness, label: string): any {
  return buttons(harness).find((button) => (button.textContent ?? "").includes(label));
}

async function click(harness: ReactDomHarness, button: any): Promise<void> {
  expect(button).toBeTruthy();
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({
      currentTarget: button,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await waitTick();
  });
}

/** Opens the list and waits for the runtime's listing to be on screen. */
async function openList(harness: ReactDomHarness, expected: string): Promise<void> {
  await click(harness, buttonWith(harness, "agent"));
  await waitUntilAct(harness.act, () => text(harness).includes(expected), { label: `list shows ${expected}` });
}

function agentRows(harness: ReactDomHarness): any[] {
  return findAllByTag(harness.dom.container, "LI");
}

describe("SessionAgentsBar", () => {
  it("renders nothing for stale, missing, or session-less inputs", async () => {
    const cases: [string, BarProps][] = [
      ["stale source", { sessionId: "s1", backgroundAgents: { running: 2, idle: 0, failed: 0, total: 2, source: "lastSeen" } }],
      ["no summary", { sessionId: "s1", backgroundAgents: undefined }],
      ["no session", { sessionId: null, backgroundAgents: liveSummary() }],
    ];
    for (const [label, props] of cases) {
      const harness = await mount(props);
      try {
        expect(text(harness), `case: ${label}`).toBe("");
      } finally {
        await harness.cleanup();
      }
    }
  });

  it("says how many agents are working and how many are idle, without reading the list", async () => {
    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary({ running: 2, idle: 1, total: 3 }) });

    expect(text(harness)).toBe("2 agents working1 idle");
    expect(fetchSessionAgents).not.toHaveBeenCalled();

    await harness.render(createElement(SessionAgentsBar, {
      sessionId: "s1",
      backgroundAgents: liveSummary({ running: 0, idle: 1, total: 1 }),
    }));
    expect(text(harness)).toBe("1 agent idle");
  });

  it("lists agents by the name they were launched under, working ones first", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-docs", { status: "idle", toolCallId: "call-docs", agentType: "general-purpose", description: "Update the docs", startedAt: at(0), activeTimeMs: 160_000 }),
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent", agentType: "general-purpose", description: "Refactor move generation", startedAt: at(10) }),
      task("a-inline", { executionMode: "sync", agentType: "task", description: "inline child" }),
      task("a-saves", { toolCallId: "call-saves", agentType: "explore", description: "Map the save files", startedAt: at(5) }),
    ]));
    const agents = buildTranscriptAgentDirectory([
      // The runtime gave this one no name; the session's history has the one it was launched under.
      record("call-docs", { name: "docs-agent", status: "finished", toolCount: 3 }),
      record("call-moves", { name: "moves-agent", toolCount: 31 }),
    ]);

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary({ running: 2, idle: 1, total: 3 }), agents });
    await openList(harness, "Refactor move generation");

    expect(fetchSessionAgents).toHaveBeenCalledWith("s1");
    const rows = agentRows(harness).map((row) => row.textContent);
    // Working agents in the order they were launched, then the idle one. The type stands in for a missing name.
    expect(rows).toEqual([
      "exploreMap the save files",
      "moves-agentRefactor move generation31 steps",
      "docs-agentUpdate the docs3 stepsidle2m 40s",
    ]);
    // An agent the main agent waits on inside its turn belongs to the transcript, not this list.
    expect(text(harness)).not.toContain("inline child");
  });

  it("shows what a working agent is doing now, and counts its time up to now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_MS + 95_000);
    fetchSessionAgents.mockResolvedValue(listing([
      // One earlier period of 30s, and one in flight that began 65s ago.
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation", activeTimeMs: 30_000, activeStartedAt: at(30) }),
      task("a-docs", { status: "idle", toolCallId: "call-docs", name: "docs-agent", description: "Update the docs" }),
    ]));
    const latestSteps = new Map([["call-moves", "Running npm test"], ["call-docs", "Read README.md"]]);

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary({ running: 1, idle: 1, total: 2 }), latestSteps });
    await openList(harness, "moves-agent");

    expect(agentRows(harness).map((row) => row.textContent)).toEqual([
      "moves-agentRunning npm test1m 35s",
      // An agent that is not working says what it was asked to do, not the last thing it did.
      "docs-agentUpdate the docsidle",
    ]);
  });

  it("counts a step as it is taken, ahead of the session's records", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation" }),
      task("a-docs", { status: "idle", toolCallId: "call-docs", name: "docs-agent", description: "Update the docs" }),
    ]));
    // The records were read four steps ago; the transcript already shows those steps.
    const agents = buildTranscriptAgentDirectory([
      record("call-moves", { name: "moves-agent", toolCount: 5 }),
      // Only the newest part of a long run is loaded, so the records know of more.
      record("call-docs", { name: "docs-agent", status: "finished", toolCount: 40 }),
    ]);
    const loadedStepCounts = new Map([["call-moves", 9], ["call-docs", 12]]);

    const harness = await mount({
      sessionId: "s1",
      backgroundAgents: liveSummary({ running: 1, idle: 1, total: 2 }),
      agents,
      loadedStepCounts,
    });
    await openList(harness, "moves-agent");

    expect(agentRows(harness).map((row) => row.textContent)).toEqual([
      "moves-agentRefactor move generation9 steps",
      "docs-agentUpdate the docs40 stepsidle",
    ]);
  });

  it("opens a row onto the agent's report and brief, read in full", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-moves", { status: "idle", toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation", latestResponse: "Moved the gen… (truncated)" }),
    ]));
    fetchSessionAgentDetail.mockReset();
    fetchSessionAgentDetail.mockResolvedValue({
      source: "live",
      task: task("a-moves", {
        status: "idle",
        name: "moves-agent",
        latestResponse: "Moved the generator into its own module and updated every caller.",
        prompt: "Refactor move generation without changing behaviour.",
      }),
    });

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary({ running: 0, idle: 1 }) });
    await openList(harness, "moves-agent");
    expect(text(harness)).not.toContain("Latest report");

    await click(harness, buttonWith(harness, "moves-agent"));
    await waitUntilAct(harness.act, () => text(harness).includes("updated every caller"), { label: "full report" });

    expect(fetchSessionAgentDetail).toHaveBeenCalledWith("s1", "a-moves");
    expect(text(harness)).toContain("Latest report");
    expect(text(harness)).toContain("Brief");
    expect(text(harness)).toContain("Refactor move generation without changing behaviour.");
    expect(text(harness)).not.toContain("(truncated)");
  });

  it("reads an opened row again when the list shows its agent has said something new", async () => {
    const listed = (latestResponse: string) => listing([
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation", latestResponse }),
    ]);
    const detail = (latestResponse: string): SessionAgentDetailResponse => ({
      source: "live",
      task: task("a-moves", { name: "moves-agent", latestResponse }),
    });
    fetchSessionAgents.mockResolvedValueOnce(listed("Reading the gen…"));
    fetchSessionAgentDetail.mockReset();
    fetchSessionAgentDetail.mockResolvedValueOnce(detail("Reading the generator before touching it."));

    const props: BarProps = { sessionId: "s1", backgroundAgents: liveSummary() };
    const harness = await mount(props);
    await openList(harness, "moves-agent");
    await click(harness, buttonWith(harness, "moves-agent"));
    await waitUntilAct(harness.act, () => text(harness).includes("before touching it"), { label: "first report" });

    // The agent works on: the same state, new words. The counts moving makes the bar read the list again.
    fetchSessionAgents.mockResolvedValue(listed("Moved the gen…"));
    fetchSessionAgentDetail.mockResolvedValue(detail("Moved the generator into its own module."));
    await harness.render(createElement(SessionAgentsBar, {
      ...props,
      backgroundAgents: liveSummary({ running: 1, idle: 1, total: 2 }),
    }));
    await waitUntilAct(harness.act, () => text(harness).includes("into its own module"), { label: "newer report" });

    expect(fetchSessionAgentDetail).toHaveBeenCalledTimes(2);
  });

  it("asks before stopping an agent", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation" }),
    ]));
    cancelSessionAgent.mockResolvedValue({ cancelled: true });

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary() });
    await openList(harness, "moves-agent");
    // Nothing on a closed row stops an agent.
    expect(buttonWith(harness, "Stop agent")).toBeUndefined();

    await click(harness, buttonWith(harness, "moves-agent"));
    await click(harness, buttonWith(harness, "Stop agent…"));
    expect(text(harness)).toContain("Stop moves-agent? What it has done so far stays in the transcript.");
    expect(cancelSessionAgent).not.toHaveBeenCalled();

    // Backing out leaves the agent alone.
    await click(harness, buttonWith(harness, "Keep it"));
    expect(text(harness)).not.toContain("Stop moves-agent?");
    expect(cancelSessionAgent).not.toHaveBeenCalled();

    await click(harness, buttonWith(harness, "Stop agent…"));
    const listReads = fetchSessionAgents.mock.calls.length;
    await click(harness, buttons(harness).find((button) => button.textContent === "Stop agent"));
    await waitUntilAct(harness.act, () => fetchSessionAgents.mock.calls.length > listReads, { label: "list re-read" });

    expect(cancelSessionAgent).toHaveBeenCalledTimes(1);
    expect(cancelSessionAgent).toHaveBeenCalledWith("s1", "a-moves");
  });

  it("says so when an agent could not be stopped", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent" }),
    ]));
    cancelSessionAgent.mockRejectedValue(new Error("Background task cancellation is not available for this session"));

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary() });
    await openList(harness, "moves-agent");
    await click(harness, buttonWith(harness, "moves-agent"));
    await click(harness, buttonWith(harness, "Stop agent…"));
    await click(harness, buttons(harness).find((button) => button.textContent === "Stop agent"));
    await waitUntilAct(harness.act, () => text(harness).includes("Could not stop the agent"), { label: "stop error" });

    expect(text(harness)).toContain("cancellation is not available for this session");
    // The question stays open so the reader can try again or back out.
    expect(text(harness)).toContain("Stop moves-agent?");
  });

  it("dismisses an idle agent after asking, and the agent leaves the list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_MS + 3 * 3_600_000);
    const docs = task("a-docs", { status: "idle", toolCallId: "call-docs", name: "docs-agent", description: "Update the docs", idleSince: at(0) });
    const moves = task("a-moves", { toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation" });
    fetchSessionAgents.mockResolvedValue(listing([moves, docs]));
    dismissSessionAgent.mockImplementation(async () => {
      fetchSessionAgents.mockResolvedValue(listing([moves]));
      return { dismissed: true };
    });

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary({ running: 1, idle: 1, total: 2 }) });
    await openList(harness, "docs-agent");

    // A working agent is stopped, not dismissed.
    await click(harness, buttonWith(harness, "moves-agent"));
    expect(buttonWith(harness, "Stop agent…")).toBeTruthy();
    expect(buttonWith(harness, "Dismiss agent")).toBeUndefined();

    await click(harness, buttonWith(harness, "docs-agent"));
    // How long it has waited is what tells a finished agent from one between follow-ups.
    expect(text(harness)).toContain("went idle 3h ago");
    await click(harness, buttonWith(harness, "Dismiss agent…"));
    expect(text(harness)).toContain("Dismiss docs-agent? It ends for good and leaves this list");
    expect(dismissSessionAgent).not.toHaveBeenCalled();

    await click(harness, buttonWith(harness, "Keep it"));
    expect(text(harness)).not.toContain("Dismiss docs-agent?");
    expect(dismissSessionAgent).not.toHaveBeenCalled();

    await click(harness, buttonWith(harness, "Dismiss agent…"));
    await click(harness, buttons(harness).find((button) => button.textContent === "Dismiss agent"));
    await waitUntilAct(harness.act, () => !text(harness).includes("docs-agent"), { label: "agent left the list" });

    expect(dismissSessionAgent).toHaveBeenCalledTimes(1);
    expect(dismissSessionAgent).toHaveBeenCalledWith("s1", "a-docs");
    expect(cancelSessionAgent).not.toHaveBeenCalled();
    expect(agentRows(harness).map((row) => row.getAttribute("data-agent-id"))).toEqual(["a-moves"]);
  });

  it("offers to dismiss an agent that has ended, and says why one was not dismissed", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-docs", { status: "completed", toolCallId: "call-docs", name: "docs-agent", description: "Update the docs" }),
    ], { backgroundAgents: liveSummary({ running: 0, idle: 0, total: 1 }) }));
    dismissSessionAgent.mockRejectedValue(new Error("The runtime did not remove the agent. Try again in a moment"));

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary() });
    await openList(harness, "docs-agent");
    await click(harness, buttonWith(harness, "docs-agent"));
    // An ended agent cannot be stopped again; dismissing it only takes it off the list.
    expect(buttonWith(harness, "Stop agent")).toBeUndefined();
    await click(harness, buttonWith(harness, "Dismiss agent…"));
    expect(text(harness)).toContain("Dismiss docs-agent? It leaves this list");

    const listReads = fetchSessionAgents.mock.calls.length;
    await click(harness, buttons(harness).find((button) => button.textContent === "Dismiss agent"));
    await waitUntilAct(harness.act, () => text(harness).includes("Could not dismiss the agent"), { label: "dismiss error" });

    expect(text(harness)).toContain("The runtime did not remove the agent");
    // The question stays open, and the list is read again in case it was out of date.
    expect(text(harness)).toContain("Dismiss docs-agent?");
    await waitUntilAct(harness.act, () => fetchSessionAgents.mock.calls.length > listReads, { label: "list re-read" });
  });

  it("says when the list is an old reading instead of presenting it as current", async () => {
    fetchSessionAgents.mockResolvedValue(listing(
      [task("a-moves", { toolCallId: "call-moves", name: "moves-agent" })],
      { source: "lastSeen", refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    ));

    const harness = await mount({ sessionId: "s1", backgroundAgents: liveSummary() });
    await openList(harness, "moves-agent");

    expect(text(harness)).toContain("Last read from the session 5m ago; it may have changed since.");
    expect(buttonWith(harness, "Refresh")).toBeTruthy();
  });

  it("opens as a sheet on a phone, through the page's history when the page owns it", async () => {
    fetchSessionAgents.mockResolvedValue(listing([
      task("a-moves", { toolCallId: "call-moves", name: "moves-agent", description: "Refactor move generation" }),
    ]));
    const onOpenSheet = vi.fn();
    const onCloseSheet = vi.fn();
    const props: BarProps = { sessionId: "s1", backgroundAgents: liveSummary(), sheetOpen: false, onOpenSheet, onCloseSheet };

    const harness = await mount(props, { phone: true });
    await click(harness, buttonWith(harness, "1 agent working"));
    // The page decides: nothing opens until it says so.
    expect(onOpenSheet).toHaveBeenCalledTimes(1);
    expect(fetchSessionAgents).not.toHaveBeenCalled();

    await harness.render(createElement(SessionAgentsBar, { ...props, sheetOpen: true }));
    await waitUntilAct(harness.act, () => text(harness).includes("Refactor move generation"), { label: "sheet list" });
    const dialog = findAllByTag(harness.dom.container, "DIV").find((element) => element.getAttribute("role") === "dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    await click(harness, buttons(harness).find((button) => button.getAttribute("aria-label") === "Close agents"));
    expect(onCloseSheet).toHaveBeenCalledTimes(1);
  });
});

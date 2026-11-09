import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import { installSelectAwareDomShim } from "../../test-dom-shim";
import type { SessionModelMoveJob, SessionModelUsage } from "../../../shared/session-model-move.js";
import type { AppSettings } from "../../api";

const apiMocks = vi.hoisted(() => ({
  fetchSessionModelMove: vi.fn(),
  fetchSessionModelUsage: vi.fn(),
  startSessionModelMove: vi.fn(),
  cancelSessionModelMove: vi.fn(),
}));
const queryMocks = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));

vi.mock("../../api", () => apiMocks);
vi.mock("../../queryClient", () => ({ queryClient: { invalidateQueries: queryMocks.invalidateQueries } }));
vi.mock("../../hooks/queries/useModels", () => ({
  useModelsQuery: () => ({
    data: [
      {
        id: "model-new",
        name: "New Model",
        supportedReasoningEfforts: ["low", "high"],
        billing: { tokenPrices: { maxPromptTokens: 200_000, longContext: { maxPromptTokens: 1_000_000 } } },
      },
      { id: "model-old", name: "Old Model" },
      { id: "model-off", name: "Disabled Model", policy: { state: "disabled" } },
    ],
  }),
}));

const { ModelMoveDisclosure } = await import("./ModelMoveDisclosure");

const USAGE: SessionModelUsage = {
  scannedAt: "2026-10-05T12:00:00.000Z",
  sessionCount: 15,
  unknownCount: 0,
  models: [
    { model: "model-old", sessionCount: 12, busyCount: 1 },
    { model: "model-retired", sessionCount: 3, busyCount: 0 },
  ],
};

function job(overrides: Partial<SessionModelMoveJob> = {}): SessionModelMoveJob {
  return {
    id: "move-1",
    status: "running",
    fromModel: "model-old",
    toModel: "model-new",
    compact: false,
    startedAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:00:00.000Z",
    total: 12,
    processed: 0,
    counts: { moved: 0, busy: 0, "needs-compaction": 0, changed: 0, failed: 0 },
    cancelRequested: false,
    results: [],
    ...overrides,
  };
}

const OPEN_LABEL = "Move existing chats to another model";

function text(harness: ReactDomHarness): string {
  return harness.dom.container.textContent ?? "";
}

function button(harness: ReactDomHarness, label: string) {
  return findAllByTag(harness.dom.container, "BUTTON").find((candidate) => candidate.textContent?.includes(label));
}

async function click(harness: ReactDomHarness, label: string) {
  const target = button(harness, label);
  expect(target, `button "${label}"`).toBeDefined();
  await harness.act(async () => {
    await getReactProps(target)?.onClick?.();
  });
}

async function choose(harness: ReactDomHarness, index: number, value: string) {
  const select = findAllByTag(harness.dom.container, "SELECT")[index];
  await harness.act(async () => {
    getReactProps(select)?.onChange?.({ target: { value } });
  });
}

async function renderSection(presets?: AppSettings["modelPresets"]) {
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  await harness.render(createElement(ModelMoveDisclosure, { presets }));
  return harness;
}

/** Opens the form and picks the old model, then Custom and the new model. */
async function openAndChoose(harness: ReactDomHarness) {
  await click(harness, OPEN_LABEL);
  await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "SELECT").length === 1);
  await choose(harness, 0, "model-old");
  await click(harness, "Custom");
  await choose(harness, 1, "model-new");
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  queryMocks.invalidateQueries.mockReset();
  apiMocks.fetchSessionModelMove.mockResolvedValue({ job: null });
  apiMocks.fetchSessionModelUsage.mockResolvedValue(USAGE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ModelMoveDisclosure", () => {

  it("moves the chats to a tier with the tier's model, effort and context", async () => {
    const harness = await renderSection({
      preset2: { model: "model-new" },
      preset3: { model: "model-new", reasoningEffort: "high", contextTier: "long_context" },
    });
    try {
      await click(harness, OPEN_LABEL);
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "SELECT").length === 1);
      await choose(harness, 0, "model-old");
      expect(getReactProps(button(harness, "Fast"))?.disabled).toBe(true);

      await click(harness, "Deep");
      expect(text(harness)).toContain("New Model · High · Long context (1M)");
      expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(1);
      apiMocks.startSessionModelMove.mockResolvedValue(job());
      await click(harness, "Move 12 chats");
      expect(apiMocks.startSessionModelMove).toHaveBeenLastCalledWith({
        fromModel: "model-old",
        toModel: "model-new",
        reasoningEffort: "high",
        contextTier: "long_context",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("applies a tier's standard context explicitly, so no chat keeps a larger window by default", async () => {
    const harness = await renderSection({ preset2: { model: "model-new" } });
    try {
      await click(harness, OPEN_LABEL);
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "SELECT").length === 1);
      await choose(harness, 0, "model-old");
      await click(harness, "Standard");
      expect(text(harness)).toContain("New Model · each chat's effort · Standard context (200K)");
      apiMocks.startSessionModelMove.mockResolvedValue(job());
      await click(harness, "Move 12 chats");
      expect(apiMocks.startSessionModelMove).toHaveBeenLastCalledWith({
        fromModel: "model-old",
        toModel: "model-new",
        contextTier: "default",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("applies the effort and context chosen for the new model to every chat", async () => {
    const harness = await renderSection();
    try {
      await openAndChoose(harness);
      const selects = findAllByTag(harness.dom.container, "SELECT");
      expect(selects).toHaveLength(4);
      expect(findAllByTag(selects[2], "OPTION").map((option) => option.textContent))
        .toEqual(["Keep each chat's", "Low", "High"]);
      expect(findAllByTag(selects[3], "OPTION").map((option) => option.textContent))
        .toEqual(["Keep each chat's size", "Standard context (200K)", "Long context (1M)"]);

      await choose(harness, 2, "high");
      await choose(harness, 3, "long_context");
      apiMocks.startSessionModelMove.mockResolvedValue(job());
      await click(harness, "Move 12 chats");
      expect(apiMocks.startSessionModelMove).toHaveBeenCalledWith({
        fromModel: "model-old",
        toModel: "model-new",
        reasoningEffort: "high",
        contextTier: "long_context",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("starts the move, follows it, and reports what was left behind", async () => {
    const harness = await renderSection();
    try {
      await openAndChoose(harness);
      expect(text(harness)).toContain("1 chat busy now. Busy chats are skipped.");
      expect(findAllByTag(findAllByTag(harness.dom.container, "SELECT")[1], "OPTION").map((option) => option.textContent))
        .toEqual(["Choose a model", "New Model", "Old Model"]);

      apiMocks.startSessionModelMove.mockResolvedValue(job());
      await click(harness, "Move 12 chats");
      expect(apiMocks.startSessionModelMove).toHaveBeenCalledWith({ fromModel: "model-old", toModel: "model-new" });
      expect(text(harness)).toContain("Moving chats from Old Model to New Model");
      expect(text(harness)).toContain("0 of 12 chats");

      apiMocks.fetchSessionModelMove.mockResolvedValue({ job: job({ processed: 5, counts: { ...job().counts, moved: 5 } }) });
      await advanceTimersByTimeAct(harness.act, 1_500);
      expect(text(harness)).toContain("5 of 12 chats");
      expect(queryMocks.invalidateQueries).not.toHaveBeenCalled();

      apiMocks.fetchSessionModelMove.mockResolvedValue({
        job: job({
          status: "completed",
          processed: 12,
          completedAt: "2026-10-05T12:05:00.000Z",
          counts: { moved: 9, busy: 1, "needs-compaction": 1, changed: 0, failed: 1 },
          results: [
            { sessionId: "busy-session-id", title: "Standup notes", outcome: "busy" },
            { sessionId: "long-session-id", title: "Long investigation", outcome: "needs-compaction", detail: "310,000 tokens, and model-new takes 200,000" },
            { sessionId: "moved-session-id", title: "Moved chat", outcome: "moved" },
            { sessionId: "failed-session-id", title: "Build review", outcome: "failed", detail: "Connection lost" },
          ],
        }),
      });
      await advanceTimersByTimeAct(harness.act, 1_500);
      await waitUntilAct(harness.act, () => text(harness).includes("Moved 9 of 12 chats"));

      expect(text(harness)).toContain("Moved 9 of 12 chats from Old Model to New Model");
      expect(text(harness)).toContain("Left as they were: 1 busy, 1 too long for New Model, 1 failed.");
      expect(text(harness)).toContain("Connection lost");
      expect(text(harness)).toContain("Standup notes");
      expect(text(harness)).toContain("Too long (310,000 tokens, and model-new takes 200,000)");
      expect(text(harness)).not.toContain("Moved chat");
      expect(queryMocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-model"] });
      expect(apiMocks.fetchSessionModelUsage).toHaveBeenLastCalledWith({ refresh: true });

      const pollsWhenFinished = apiMocks.fetchSessionModelMove.mock.calls.length;
      await advanceTimersByTimeAct(harness.act, 6_000);
      expect(apiMocks.fetchSessionModelMove).toHaveBeenCalledTimes(pollsWhenFinished);
    } finally {
      await harness.cleanup();
    }
  });

  it("offers to compact the chats that were too long, and to retry the busy ones", async () => {
    const finished = job({
      status: "completed",
      processed: 12,
      counts: { moved: 9, busy: 2, "needs-compaction": 1, changed: 0, failed: 0 },
    });
    apiMocks.startSessionModelMove.mockResolvedValue(finished);
    const harness = await renderSection();
    try {
      await openAndChoose(harness);
      await click(harness, "Move 12 chats");
      await waitUntilAct(harness.act, () => text(harness).includes("Moved 9 of 12 chats"));

      await click(harness, "Compact and move 1 chat");
      expect(apiMocks.startSessionModelMove).toHaveBeenLastCalledWith({
        fromModel: "model-old",
        toModel: "model-new",
        compact: true,
      });

      await click(harness, "Try the rest again");
      expect(apiMocks.startSessionModelMove).toHaveBeenLastCalledWith({ fromModel: "model-old", toModel: "model-new" });

      await click(harness, "Move other chats");
      expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(4);
    } finally {
      await harness.cleanup();
    }
  });

  it("opens the model-move form on demand and closes it after all selected chats move", async () => {
    apiMocks.startSessionModelMove.mockResolvedValue(job({
      status: "completed",
      processed: 12,
      counts: { ...job().counts, moved: 12 },
    }));
    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => apiMocks.fetchSessionModelMove.mock.calls.length === 1);
      expect(text(harness)).toBe(OPEN_LABEL);
      expect(getReactProps(button(harness, OPEN_LABEL))?.["aria-expanded"]).toBe(false);
      expect(apiMocks.fetchSessionModelUsage).not.toHaveBeenCalled();

      await click(harness, OPEN_LABEL);
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "SELECT").length === 1);

      expect(apiMocks.fetchSessionModelUsage).toHaveBeenCalledWith({ refresh: false });
      const [from] = findAllByTag(harness.dom.container, "SELECT");
      expect(findAllByTag(from, "OPTION").map((option) => option.textContent)).toEqual([
        "Choose a model",
        "Old Model · 12 chats",
        "model-retired · 3 chats",
      ]);
      await click(harness, "Custom");
      const to = findAllByTag(harness.dom.container, "SELECT")[1];
      expect(findAllByTag(to, "OPTION").map((option) => option.textContent)).toEqual([
        "Choose a model",
        "New Model",
        "Old Model",
      ]);
      expect(getReactProps(button(harness, "Move chats"))?.disabled).toBe(true);

      await choose(harness, 0, "model-old");
      await choose(harness, 1, "model-new");
      await click(harness, "Move 12 chats");
      await waitUntilAct(harness.act, () => Boolean(button(harness, "Done")));
      expect(text(harness)).toContain("Moved 12 of 12 chats from Old Model to New Model");
      expect(text(harness)).not.toContain("Left as they were");
      expect(button(harness, "Try the rest again")).toBeUndefined();

      await click(harness, "Done");
      expect(text(harness)).toBe(OPEN_LABEL);
      expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("shows why a move could not start and keeps the form", async () => {
    apiMocks.startSessionModelMove.mockRejectedValue(new Error("Model is not available: model-new"));
    const harness = await renderSection();
    try {
      await openAndChoose(harness);
      await click(harness, "Move 12 chats");
      await waitUntilAct(harness.act, () => text(harness).includes("Model is not available: model-new"));
      expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(4);
    } finally {
      await harness.cleanup();
    }
  });

  it("picks up a move that is already running and can stop it", async () => {
    apiMocks.fetchSessionModelMove.mockResolvedValue({ job: job({ processed: 3 }) });
    apiMocks.cancelSessionModelMove.mockResolvedValue({ job: job({ processed: 3, cancelRequested: true }) });
    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => text(harness).includes("3 of 12 chats"));
      expect(apiMocks.fetchSessionModelUsage).not.toHaveBeenCalled();
      // The line itself carries the progress, so it shows while the line is closed too.
      expect(button(harness, OPEN_LABEL)?.textContent).toContain("3 of 12");
      await click(harness, OPEN_LABEL);
      expect(text(harness)).toBe(`${OPEN_LABEL}3 of 12`);
      await click(harness, OPEN_LABEL);

      await click(harness, "Stop");
      expect(apiMocks.cancelSessionModelMove).toHaveBeenCalledOnce();
      expect(getReactProps(button(harness, "Stopping…"))?.disabled).toBe(true);

      apiMocks.fetchSessionModelMove.mockResolvedValue({
        job: job({ status: "cancelled", processed: 4, cancelRequested: true, counts: { ...job().counts, moved: 4 } }),
      });
      await advanceTimersByTimeAct(harness.act, 1_500);
      await waitUntilAct(harness.act, () => text(harness).includes("Stopped early."));
      expect(text(harness)).toContain("Stopped early. Moved 4 of 12 chats from Old Model to New Model");
      expect(text(harness)).toContain("Left as they were: 8 not tried.");
    } finally {
      await harness.cleanup();
    }
  });

  it("says so when the server forgot the move after a restart", async () => {
    apiMocks.fetchSessionModelMove.mockResolvedValueOnce({ job: job({ processed: 3 }) });
    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => text(harness).includes("3 of 12 chats"));

      apiMocks.fetchSessionModelMove.mockResolvedValue({ job: null });
      await advanceTimersByTimeAct(harness.act, 1_500);
      await waitUntilAct(harness.act, () => text(harness).includes("The server restarted before the move finished."));
      expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("offers a retry when the chats cannot be counted", async () => {
    apiMocks.fetchSessionModelUsage.mockRejectedValueOnce(new Error("Session list is unavailable"));
    const harness = await renderSection();
    try {
      await click(harness, OPEN_LABEL);
      await waitUntilAct(harness.act, () => text(harness).includes("Session list is unavailable"));

      await click(harness, "Retry");
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "SELECT").length === 1);
      expect(text(harness)).not.toContain("Session list is unavailable");
    } finally {
      await harness.cleanup();
    }
  });
});

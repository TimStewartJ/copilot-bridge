import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotContextTier, CopilotModelContextMetadata } from "../../shared/copilot-context.js";
import {
  createSessionModelMover,
  parseSessionModelMoveRequest,
  resolveMoveContextTier,
  SessionModelMoveInProgressError,
  SessionModelMoveRequestError,
} from "../session-model-move.js";
import type { SessionModelSwitchResult } from "../session-manager.js";

interface FakeSession {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  busy?: boolean;
  loaded?: boolean;
  title?: string;
}

const OLD = "model-old";
const NEW = "model-new";
const TIERED_PRICES = { tokenPrices: { contextMax: 200_000, longContext: { contextMax: 900_000 } } };
const NEW_MODEL: CopilotModelContextMetadata = {
  id: NEW,
  supportedReasoningEfforts: ["low", "medium", "high"],
  billing: TIERED_PRICES,
};

function createHarness(
  sessions: Record<string, FakeSession>,
  options: { models?: CopilotModelContextMetadata[] } = {},
) {
  let clock = Date.parse("2026-10-05T12:00:00.000Z");
  let pendingRun: (() => Promise<void>) | undefined;
  const setSessionModel = vi.fn(async (
    sessionId: string,
    model: string,
    reasoningEffort?: string,
    contextTier?: CopilotContextTier,
  ): Promise<SessionModelSwitchResult> => {
    const session = sessions[sessionId]!;
    session.model = model;
    if (reasoningEffort) session.reasoningEffort = reasoningEffort;
    session.contextTier = contextTier;
    session.loaded = true;
    return { status: "applied", model };
  });
  const unloadSession = vi.fn(async (sessionId: string) => {
    sessions[sessionId]!.loaded = false;
    return true;
  });
  const getSessionModelState = vi.fn(async (sessionId: string) => {
    const { model, reasoningEffort, contextTier } = sessions[sessionId]!;
    return {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextTier ? { contextTier } : {}),
    };
  });
  const mover = createSessionModelMover({
    listSessions: async () => Object.entries(sessions).map(([sessionId, session]) => ({
      sessionId,
      ...(session.title ? { title: session.title } : {}),
    })),
    getSessionModelState,
    isSessionBusy: (sessionId) => sessions[sessionId]!.busy === true,
    isSessionLoaded: (sessionId) => sessions[sessionId]!.loaded === true,
    setSessionModel,
    unloadSession,
    listModels: async () => options.models ?? [NEW_MODEL],
    now: () => clock,
    createId: () => "move-1",
    schedule: (run) => { pendingRun = run; },
  });
  return {
    mover,
    setSessionModel,
    unloadSession,
    getSessionModelState,
    advance: (ms: number) => { clock += ms; },
    /** Runs the move a `start` call queued, to its end. */
    runMove: async () => {
      const run = pendingRun;
      pendingRun = undefined;
      await run?.();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session model mover", () => {
  it("counts a chat whose model cannot be read as unknown instead of failing the count", async () => {
    const { mover, getSessionModelState } = createHarness({ a: { model: OLD }, b: { model: OLD } });
    getSessionModelState.mockRejectedValueOnce(new Error("events.jsonl is locked"));

    await expect(mover.getUsage()).resolves.toMatchObject({ sessionCount: 2, unknownCount: 1 });
  });

  it("reads the chats once for a count, a dry run and the move that follows, and again on refresh", async () => {
    const { mover, getSessionModelState, advance, runMove } = createHarness({ a: { model: OLD } });

    await mover.getUsage();
    await mover.getUsage();
    await mover.plan({ fromModel: OLD, toModel: NEW });
    expect(getSessionModelState).toHaveBeenCalledTimes(1);

    await mover.getUsage({ refresh: true });
    expect(getSessionModelState).toHaveBeenCalledTimes(2);

    advance(61_000);
    await mover.getUsage();
    expect(getSessionModelState).toHaveBeenCalledTimes(3);

    // Starting reuses the count; the one further read is the check right before the chat's switch.
    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();
    expect(getSessionModelState).toHaveBeenCalledTimes(4);

    // A finished move changed the chats, so the next count reads them again.
    await expect(mover.getUsage()).resolves.toMatchObject({ models: [{ model: NEW, sessionCount: 1 }] });
    expect(getSessionModelState).toHaveBeenCalledTimes(5);
  });

  it("plans a move without changing any chat", async () => {
    const { mover, setSessionModel } = createHarness({
      a: { model: OLD, title: "First", reasoningEffort: "high" },
      b: { model: NEW },
      c: { model: OLD, busy: true },
      d: {},
    });

    await expect(mover.getUsage()).resolves.toEqual({
      scannedAt: "2026-10-05T12:00:00.000Z",
      sessionCount: 4,
      unknownCount: 1,
      models: [
        { model: OLD, sessionCount: 2, busyCount: 1 },
        { model: NEW, sessionCount: 1, busyCount: 0 },
      ],
    });

    await expect(mover.plan({ fromModel: OLD, toModel: NEW })).resolves.toEqual({
      dryRun: true,
      fromModel: OLD,
      toModel: NEW,
      sessions: [
        { sessionId: "a", title: "First", busy: false, reasoningEffort: "high" },
        { sessionId: "c", busy: true },
      ],
    });
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(mover.getJob()).toBeUndefined();
  });

  it("moves every chat on the old model and leaves the others alone", async () => {
    const sessions: Record<string, FakeSession> = {
      a: { model: OLD, title: "First", reasoningEffort: "medium", contextTier: "long_context" },
      b: { model: "model-other" },
      d: { model: OLD, reasoningEffort: "xhigh", contextTier: "default" },
      c: { model: OLD, loaded: true },
    };
    const { mover, setSessionModel, unloadSession, runMove } = createHarness(sessions);

    const started = await mover.start({ fromModel: OLD, toModel: NEW });
    expect(started).toMatchObject({ id: "move-1", status: "running", total: 3, processed: 0, compact: false });

    await runMove();

    expect(setSessionModel.mock.calls).toEqual([
      ["a", NEW, "medium", "long_context"],
      ["d", NEW, "high", undefined],
      ["c", NEW, undefined, undefined],
    ]);
    expect(unloadSession.mock.calls).toEqual([["a"], ["d"]]);
    expect(sessions.c!.loaded).toBe(true);
    expect(sessions.b!.model).toBe("model-other");
    expect(mover.getJob()).toMatchObject({
      status: "completed",
      processed: 3,
      completedAt: "2026-10-05T12:00:00.000Z",
      counts: { moved: 3, busy: 0, "needs-compaction": 0, changed: 0, failed: 0 },
      results: [
        { sessionId: "a", title: "First", outcome: "moved", previousReasoningEffort: "medium" },
        { sessionId: "d", outcome: "moved", previousReasoningEffort: "xhigh" },
        { sessionId: "c", outcome: "moved" },
      ],
    });
    expect(mover.getJob()).not.toHaveProperty("currentSessionId");
  });

  it("finishes at once when no chat is on the old model", async () => {
    const { mover, setSessionModel } = createHarness({ a: { model: NEW } });

    await expect(mover.start({ fromModel: OLD, toModel: NEW })).resolves.toMatchObject({
      status: "completed",
      total: 0,
      completedAt: "2026-10-05T12:00:00.000Z",
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("applies the effort and context the request names to every chat", async () => {
    const { mover, setSessionModel, runMove } = createHarness({
      a: { model: OLD, reasoningEffort: "high", contextTier: "long_context" },
    });

    await mover.start({ fromModel: OLD, toModel: NEW, reasoningEffort: "low", contextTier: "default" });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledWith("a", NEW, "low", "default");
    expect(mover.getJob()).toMatchObject({
      reasoningEffort: "low",
      contextTier: "default",
      results: [{ outcome: "moved", previousReasoningEffort: "high", previousContextTier: "long_context" }],
    });
  });

  it("still finishes the chat when unloading it fails", async () => {
    const { mover, unloadSession, runMove } = createHarness({ cold: { model: OLD } });
    unloadSession.mockRejectedValueOnce(new Error("cleanup queue is full"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(mover.getJob()).toMatchObject({ status: "completed", counts: { moved: 1 } });
  });

  it("skips busy chats, including one that became busy just before its switch", async () => {
    const sessions: Record<string, FakeSession> = {
      busy: { model: OLD, busy: true },
      racing: { model: OLD },
    };
    const { mover, setSessionModel, runMove } = createHarness(sessions);
    setSessionModel.mockRejectedValueOnce(new Error("Cannot switch model on a busy session"));

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect(sessions.busy!.model).toBe(OLD);
    expect(mover.getJob()).toMatchObject({
      status: "completed",
      counts: { moved: 0, busy: 2, failed: 0 },
      results: [{ sessionId: "busy", outcome: "busy" }, { sessionId: "racing", outcome: "busy" }],
    });
  });

  it("leaves a chat that was switched by hand since the count", async () => {
    const sessions: Record<string, FakeSession> = { a: { model: OLD }, b: { model: OLD } };
    const { mover, setSessionModel, runMove } = createHarness(sessions);

    await mover.start({ fromModel: OLD, toModel: NEW });
    sessions.b!.model = "model-other";
    await runMove();

    expect(setSessionModel.mock.calls.map(([sessionId]) => sessionId)).toEqual(["a"]);
    expect(mover.getJob()?.results[1]).toEqual({ sessionId: "b", outcome: "changed", detail: "Now on model-other" });
  });

  it("leaves a conversation that does not fit the new model unless compaction was asked for", async () => {
    const sessions: Record<string, FakeSession> = { big: { model: OLD } };
    const { mover, setSessionModel, unloadSession, runMove } = createHarness(sessions);
    setSessionModel.mockResolvedValueOnce({
      status: "confirmation_required",
      model: NEW,
      confirmation: { targetModelDisplayName: "New", currentTokens: 310_000, targetLimit: 200_000 },
    });

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect(sessions.big!.model).toBe(OLD);
    expect(unloadSession).toHaveBeenCalledWith("big");
    expect(mover.getJob()).toMatchObject({
      status: "completed",
      counts: { moved: 0, "needs-compaction": 1 },
      results: [{ outcome: "needs-compaction", detail: "310,000 tokens, and model-new takes 200,000" }],
    });
  });

  it("compacts and moves such a conversation when the request allows it", async () => {
    const sessions: Record<string, FakeSession> = { big: { model: OLD, reasoningEffort: "high" } };
    const { mover, setSessionModel, runMove } = createHarness(sessions);
    setSessionModel.mockResolvedValueOnce({
      status: "confirmation_required",
      model: NEW,
      confirmation: { targetModelDisplayName: "New", currentTokens: 310_000, targetLimit: 200_000 },
    });

    await mover.start({ fromModel: OLD, toModel: NEW, compact: true });
    await runMove();

    expect(setSessionModel.mock.calls).toEqual([
      ["big", NEW, "high", undefined],
      ["big", NEW, "high", undefined, { compactionDecision: "compact" }],
    ]);
    expect(mover.getJob()).toMatchObject({ compact: true, counts: { moved: 1, "needs-compaction": 0 } });
  });

  it("reports a switch the runtime did not apply as failed", async () => {
    const { mover, setSessionModel, runMove } = createHarness({ a: { model: OLD } });
    setSessionModel.mockResolvedValueOnce({ status: "cancelled", model: NEW, warning: "Model is not entitled" });

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(mover.getJob()?.results).toEqual([{ sessionId: "a", outcome: "failed", detail: "Model is not entitled" }]);
  });

  it("limits the move to the chats the request names", async () => {
    const sessions: Record<string, FakeSession> = { a: { model: OLD }, b: { model: OLD }, c: { model: NEW } };
    const { mover, setSessionModel, runMove } = createHarness(sessions);

    await expect(mover.start({ fromModel: OLD, toModel: NEW, sessionIds: ["b", "c"] }))
      .resolves.toMatchObject({ total: 1 });
    await runMove();

    expect(setSessionModel.mock.calls.map(([sessionId]) => sessionId)).toEqual(["b"]);
    expect(sessions.a!.model).toBe(OLD);
  });

  it("stops after three chats in a row fail and leaves the rest untouched", async () => {
    const sessions: Record<string, FakeSession> = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((id) => [id, { model: OLD }]),
    );
    const { mover, setSessionModel, runMove } = createHarness(sessions);
    setSessionModel.mockRejectedValue(new Error("Agent backend is unavailable"));

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledTimes(3);
    expect(mover.getJob()).toMatchObject({
      status: "stopped",
      total: 5,
      processed: 3,
      counts: { failed: 3 },
      stopReason: "3 chats in a row failed. The last error: Agent backend is unavailable",
    });
  });

  it("keeps going when failures are not consecutive", async () => {
    const sessions: Record<string, FakeSession> = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((id) => [id, { model: OLD }]),
    );
    const { mover, setSessionModel, runMove } = createHarness(sessions);
    const applied = setSessionModel.getMockImplementation()!;
    setSessionModel.mockImplementation(async (sessionId, ...rest) => {
      if (sessionId === "a" || sessionId === "b" || sessionId === "d") throw new Error("resumeSession timed out after 60s");
      return applied(sessionId, ...rest);
    });

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(mover.getJob()).toMatchObject({ status: "completed", processed: 5, counts: { moved: 2, failed: 3 } });
  });

  it("stops on request after the chat it is switching", async () => {
    const sessions: Record<string, FakeSession> = { a: { model: OLD }, b: { model: OLD }, c: { model: OLD } };
    const { mover, setSessionModel, runMove } = createHarness(sessions);
    const applied = setSessionModel.getMockImplementation()!;
    setSessionModel.mockImplementation(async (sessionId, ...rest) => {
      expect(mover.getJob()).toMatchObject({ status: "running", currentSessionId: sessionId });
      if (sessionId === "a") expect(mover.cancel()).toMatchObject({ status: "running", cancelRequested: true });
      return applied(sessionId, ...rest);
    });

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect(sessions).toMatchObject({ a: { model: NEW }, b: { model: OLD }, c: { model: OLD } });
    expect(mover.getJob()).toMatchObject({ status: "cancelled", total: 3, processed: 1, counts: { moved: 1 } });
  });

  it("refuses a second move while one is running, and allows one afterwards", async () => {
    const { mover, runMove } = createHarness({ a: { model: OLD }, b: { model: "model-third" } });

    await mover.start({ fromModel: OLD, toModel: NEW });
    const refused = mover.start({ fromModel: "model-third", toModel: NEW });
    await expect(refused).rejects.toBeInstanceOf(SessionModelMoveInProgressError);
    await expect(refused).rejects.toMatchObject({ job: { id: "move-1", fromModel: OLD } });

    await runMove();
    await expect(mover.start({ fromModel: "model-third", toModel: NEW })).resolves.toMatchObject({ total: 1 });
  });

  it("rejects a move from a model to itself that changes nothing", async () => {
    const { mover } = createHarness({ a: { model: OLD } });

    await expect(mover.start({ fromModel: OLD, toModel: ` ${OLD} ` })).rejects.toBeInstanceOf(SessionModelMoveRequestError);
    await expect(mover.plan({ fromModel: OLD, toModel: OLD })).rejects.toBeInstanceOf(SessionModelMoveRequestError);
  });

  it("carries each chat's settings over as they are when the new model is not in the model list", async () => {
    const { mover, setSessionModel, runMove } = createHarness(
      { a: { model: OLD, reasoningEffort: "xhigh", contextTier: "long_context" } },
      { models: [] },
    );

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledWith("a", NEW, undefined, undefined);
  });

  it("puts chats from a model with one large window on the new model's long context", async () => {
    const { mover, setSessionModel, runMove } = createHarness(
      { a: { model: OLD, reasoningEffort: "high" } },
      { models: [{ id: OLD, capabilities: { limits: { max_prompt_tokens: 1_000_000 } } }, NEW_MODEL] },
    );

    await mover.start({ fromModel: OLD, toModel: NEW });
    await runMove();

    expect(setSessionModel).toHaveBeenCalledWith("a", NEW, "high", "long_context");
  });

  it("changes the context of chats that stay on their model, and leaves the ones already there", async () => {
    const { mover, setSessionModel, runMove } = createHarness(
      {
        short: { model: NEW, reasoningEffort: "high", contextTier: "default" },
        long: { model: NEW, reasoningEffort: "high", contextTier: "long_context" },
      },
    );

    await mover.start({ fromModel: NEW, toModel: NEW, contextTier: "long_context" });
    await runMove();

    expect(setSessionModel.mock.calls).toEqual([["short", NEW, "high", "long_context"]]);
    expect(mover.getJob()).toMatchObject({ status: "completed", counts: { moved: 2 } });
  });
});

describe("resolveMoveContextTier", () => {
  it("keeps long context only when the new model offers it", () => {
    expect(resolveMoveContextTier(undefined, "long_context", undefined, NEW_MODEL)).toBe("long_context");
    expect(resolveMoveContextTier(undefined, "long_context", undefined, { id: NEW })).toBeUndefined();
    expect(resolveMoveContextTier(undefined, "default", undefined, NEW_MODEL)).toBeUndefined();
    expect(resolveMoveContextTier("default", "long_context", undefined, NEW_MODEL)).toBe("default");
  });

  it("keeps a large single window large instead of dropping to the new model's standard one", () => {
    const largeOnly: CopilotModelContextMetadata = { id: OLD, capabilities: { limits: { max_prompt_tokens: 1_000_000 } } };
    const smallOnly: CopilotModelContextMetadata = { id: OLD, capabilities: { limits: { max_prompt_tokens: 128_000 } } };
    const tieredOld: CopilotModelContextMetadata = { id: OLD, billing: TIERED_PRICES, capabilities: { limits: { max_prompt_tokens: 900_000 } } };

    expect(resolveMoveContextTier(undefined, undefined, largeOnly, NEW_MODEL)).toBe("long_context");
    expect(resolveMoveContextTier(undefined, undefined, smallOnly, NEW_MODEL)).toBeUndefined();
    // A chat on a tiered model's standard tier stays standard even though the model's largest window is bigger.
    expect(resolveMoveContextTier(undefined, undefined, tieredOld, NEW_MODEL)).toBeUndefined();
    expect(resolveMoveContextTier(undefined, "default", tieredOld, NEW_MODEL)).toBeUndefined();
  });
});

describe("parseSessionModelMoveRequest", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";

  it("accepts a full request and trims the model names", () => {
    expect(parseSessionModelMoveRequest({
      fromModel: ` ${OLD} `,
      toModel: NEW,
      reasoningEffort: "high",
      contextTier: "long_context",
      compact: true,
      sessionIds: [sessionId],
      dryRun: true,
    })).toEqual({
      request: {
        fromModel: OLD,
        toModel: NEW,
        reasoningEffort: "high",
        contextTier: "long_context",
        compact: true,
        sessionIds: [sessionId],
        dryRun: true,
      },
    });
    expect(parseSessionModelMoveRequest({ fromModel: OLD, toModel: NEW })).toEqual({
      request: { fromModel: OLD, toModel: NEW },
    });
  });

  it.each([
    [undefined, /JSON body/],
    [{ toModel: NEW }, /fromModel/],
    [{ fromModel: OLD, toModel: "  " }, /toModel/],
    [{ fromModel: OLD, toModel: NEW, reasoningEffort: 3 }, /reasoningEffort/],
    [{ fromModel: OLD, toModel: NEW, contextTier: "huge" }, /contextTier/],
    [{ fromModel: OLD, toModel: NEW, compact: "yes" }, /compact/],
    [{ fromModel: OLD, toModel: NEW, dryRun: 1 }, /dryRun/],
    [{ fromModel: OLD, toModel: NEW, sessionIds: [] }, /sessionIds/],
    [{ fromModel: OLD, toModel: NEW, sessionIds: ["not-a-session-id"] }, /sessionIds/],
  ])("rejects %j", (body, error) => {
    expect(parseSessionModelMoveRequest(body)).toEqual({ error: expect.stringMatching(error) });
  });
});

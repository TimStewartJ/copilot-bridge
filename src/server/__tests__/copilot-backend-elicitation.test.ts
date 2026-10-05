// CopilotAgentSession.requestElicitation: a form the Bridge asks the user from inside a tool.
// The adapter's other tests are in src/server/agent-backend/__tests__/copilot-backend.test.ts.

import { describe, expect, it, vi } from "vitest";
import { CopilotBackend } from "../agent-backend/copilot-backend.js";
import { AGENT_RPC_TIMEOUTS_MS } from "../agent-backend/rpc-timeouts.js";

function createFakeSession(rpc: any = {}) {
  return {
    sessionId: "fake-session-id",
    send: vi.fn(async () => undefined),
    sendAndWait: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn((_handler: (event: any) => void) => () => undefined),
    getEvents: vi.fn(async () => []),
    registerElicitationHandler: vi.fn(),
    rpc: {
      permissions: { setMode: vi.fn(async () => ({ success: true, mode: "allow-all" })) },
      ...rpc,
    },
  };
}

function createFakeClient(session: ReturnType<typeof createFakeSession>) {
  return {
    session,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => [] as Error[]),
    forceStop: vi.fn(async () => undefined),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
  };
}

describe("CopilotAgentSession requestElicitation", () => {
  it("asks the user a form through rpc.ui.elicitation and returns the answer", async () => {
    const form = {
      message: "The browser needs you: pass the check on example.test",
      requestedSchema: {
        type: "object",
        properties: { handoff_1a2b3c4d: { type: "string", enum: ["done", "not_done"] } },
        required: ["handoff_1a2b3c4d"],
      },
    };
    const answer = { action: "accept" as const, content: { handoff_1a2b3c4d: "done" } };
    const ui = {
      elicitation: vi.fn(async function (this: unknown, _request: unknown) {
        // The generated RPC methods are not bound.
        expect(this).toBe(ui);
        return answer;
      }),
    };
    const wrapped = await new CopilotBackend(createFakeClient(createFakeSession({ ui })) as any).createSession({});

    await expect(wrapped.requestElicitation!(form)).resolves.toBe(answer);
    expect(ui.elicitation).toHaveBeenCalledTimes(1);
    expect(ui.elicitation).toHaveBeenCalledWith(form);

    ui.elicitation.mockResolvedValueOnce({ action: "decline" } as never);
    await expect(wrapped.requestElicitation!(form)).resolves.toEqual({ action: "decline" });
    ui.elicitation.mockRejectedValueOnce(new Error("session connection closed"));
    await expect(wrapped.requestElicitation!(form)).rejects.toThrow("session connection closed");
  });

  it("waits for a person to answer a form for longer than any RPC bound", async () => {
    vi.useFakeTimers();
    try {
      let answerForm!: (answer: { action: "cancel" }) => void;
      const elicitation = vi.fn(() => new Promise<{ action: "cancel" }>((resolve) => {
        answerForm = resolve;
      }));
      const wrapped = await new CopilotBackend(
        createFakeClient(createFakeSession({ ui: { elicitation } })) as any,
      ).createSession({});
      let outcome: unknown;
      const asking = wrapped.requestElicitation!({ message: "Approve?", requestedSchema: { type: "object", properties: {} } })
        .then((answer) => { outcome = answer; }, (error) => { outcome = error; });

      await vi.advanceTimersByTimeAsync(Math.max(...Object.values(AGENT_RPC_TIMEOUTS_MS)) + 60_000);
      expect(outcome).toBeUndefined();

      answerForm({ action: "cancel" });
      await asking;
      expect(outcome).toEqual({ action: "cancel" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails clearly when the SDK build cannot ask the user from a tool", async () => {
    const withoutUi = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({});
    const withoutElicitation = await new CopilotBackend(
      createFakeClient(createFakeSession({ ui: { handlePendingElicitation: vi.fn() } })) as any,
    ).createSession({});

    for (const wrapped of [withoutUi, withoutElicitation]) {
      await expect(wrapped.requestElicitation!({ message: "Approve?", requestedSchema: {} }))
        .rejects.toThrow("Asking the user from a tool is not available in this Copilot SDK build");
    }
  });
});

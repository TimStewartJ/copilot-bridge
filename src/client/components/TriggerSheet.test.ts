import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TriggerView } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchSessionTriggers: vi.fn(),
  runTrigger: vi.fn(async (..._args: unknown[]) => ({})),
  updateTrigger: vi.fn(async (..._args: unknown[]) => ({})),
  cancelTrigger: vi.fn(async (..._args: unknown[]) => ({})),
  reactivateTrigger: vi.fn(async (..._args: unknown[]) => ({})),
  deleteTrigger: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), ...apiMocks }));

const { default: TriggerSheet } = await import("./TriggerSheet");

function trigger(overrides: Partial<TriggerView>): TriggerView {
  return {
    id: "trigger-1",
    prompt: "Watch build 123",
    then: "worker",
    sessionId: "session-1",
    when: { kind: "every", seconds: 300 },
    whenLabel: "every 5 min",
    status: "active",
    runNow: false,
    runCount: 3,
    fireCount: 1,
    attempts: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    canRun: false,
    canPause: false,
    canResume: false,
    canCancel: false,
    canReactivate: false,
    ...overrides,
  };
}

describe("TriggerSheet", () => {
  it("lists the chat's triggers and sends each action to its endpoint", async () => {
    apiMocks.fetchSessionTriggers.mockResolvedValue({
      sessionId: "session-1",
      triggers: [
        trigger({
          id: "watch",
          name: "Build monitor",
          canRun: true,
          canPause: true,
          canCancel: true,
          check: { command: ["gh", "run", "view", "123"], timeoutSeconds: 60, fireOn: "change" },
          lastCheck: { outcome: "changed", at: "2026-09-01T23:00:00.000Z", exitCode: 1, actionPending: true },
          checkpoint: { buildId: 123 },
        }),
        trigger({ id: "done", prompt: "Report the release\nwith details", status: "completed", canReactivate: true, failedDelivery: true }),
      ],
      recentRuns: [{ id: 1, triggerId: "watch", action: "notify", durationMs: 900, completedAt: "2026-09-01T23:00:00.000Z" }],
      recentDeliveries: [{ id: "delivery-1", triggerId: "done", status: "failed", createdAt: "2026-09-01T22:00:00.000Z", updatedAt: "2026-09-01T22:00:00.000Z", error: "Chat is gone" }],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(QueryClientProvider, { client: queryClient },
        createElement(TriggerSheet, { session: { sessionId: "session-1", summary: "Build chat" }, onClose: vi.fn() })));
      const text = () => harness.dom.container.textContent ?? "";
      await waitUntilAct(harness.act, () => text().includes("Build monitor"), { label: "triggers loaded" });

      expect(apiMocks.fetchSessionTriggers).toHaveBeenCalledWith("session-1", expect.anything());
      expect(text()).toContain("Every 5 min");
      expect(text()).toContain("Checkgh run view 123Fires on changeChanged");
      expect(text()).toContain("· exit 1 · action pending");
      expect(text()).toContain("Checkpoint1 key");
      // A trigger without a name is shown by the first line of its prompt.
      expect(text()).toContain("Report the release");
      expect(text()).toContain("Build monitor · Told the chat and continued");
      expect(text()).toContain("Report the release · Failed");
      expect(text()).toContain("Chat is gone");

      const click = async (label: string) => {
        const button = findAllByTag(harness.dom.container, "BUTTON").find((candidate) => candidate.textContent === label);
        expect(button, label).toBeDefined();
        await harness.act(async () => { await getReactProps(button)?.onClick?.(); });
      };
      await click("Run now");
      await click("Pause");
      await click("Cancel");
      await click("Send result again");
      expect(apiMocks.runTrigger).toHaveBeenCalledWith("watch");
      expect(apiMocks.updateTrigger).toHaveBeenCalledWith("watch", { active: false });
      expect(apiMocks.cancelTrigger).toHaveBeenCalledWith("watch");
      expect(apiMocks.reactivateTrigger).toHaveBeenCalledWith("done");
    } finally {
      await harness.cleanup();
      queryClient.clear();
    }
  });
});

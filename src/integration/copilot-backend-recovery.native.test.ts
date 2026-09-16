import { spawn, type ChildProcess } from "node:child_process";
import { CopilotClient } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { CopilotBackend } from "../server/agent-backend/copilot-backend.js";
import { SessionManager } from "../server/session-manager.js";
import { buildCopilotClientOptions } from "../server/copilot-client-options.js";
import { createEventBusRegistry } from "../server/event-bus.js";
import { createSessionTitlesStore } from "../server/session-titles.js";
import { createTaskStore } from "../server/task-store.js";
import { createTelemetryStore } from "../server/telemetry-store.js";
import { createDeadline } from "../server/deadline.js";
import { getProcessIdentityStatuses, PROCESS_TREE_TERMINATION_BUDGET_MS, sampleProcessTree } from "../server/platform.js";
import { createTestBus, makeTestDir, setupTestDb } from "../server/__tests__/helpers.js";

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { child.off("message", onMessage); reject(error); };
    const onMessage = () => { child.off("error", onError); resolve(); };
    child.once("error", onError);
    child.once("message", onMessage);
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
    child.kill();
  });
}

describe("owned Copilot stdio recovery on the actual host platform", () => {
  it("fences a live isolated runtime before replacing it without touching an unrelated process", async () => {
    const db = setupTestDb();
    const copilotHome = makeTestDir("copilot-fence-native");
    const globalBus = createTestBus();
    const telemetryStore = createTelemetryStore(db);
    const clients = [0, 1].map(() => new CopilotClient({
      ...buildCopilotClientOptions({ ...process.env, COPILOT_HOME: copilotHome }), useLoggedInUser: false,
    }));
    const backends = clients.map((client) => new CopilotBackend(client, { localStdioOwnership: true }));
    let created = 0;
    const manager = new SessionManager({
      globalBus, eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db), taskStore: createTaskStore(db, globalBus),
      config: { sessionMcpServers: {} }, copilotHome, telemetryStore,
      createBackend: () => {
        const backend = backends[created++];
        if (!backend) throw new Error("Unexpected additional native backend");
        return backend;
      },
    });
    let resolveRecovery!: () => void;
    let rejectRecovery!: (error: Error) => void;
    const recovered = new Promise<void>((resolve, reject) => { resolveRecovery = resolve; rejectRecovery = reject; });
    const unsubscribe = globalBus.subscribe((event) => {
      if (event.type !== "backend:status" || !event.agentBackend) return;
      if (event.agentBackend.state === "ready" && event.agentBackend.recoveryCount === 1) resolveRecovery();
      else if (event.agentBackend.recoveryBlockedAt) {
        // Transient fencing failures are retried; only a blocked recovery is final.
        rejectRecovery(new Error(event.agentBackend.lastRecoveryError ?? "Agent backend recovery blocked"));
      }
    });
    const unrelated = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
    });
    try {
      await waitForReady(unrelated);
      await manager.initialize();
      const oldPid = manager.getBackendStatus().pid;
      expect(oldPid).toBeDefined();
      const owned = await sampleProcessTree(oldPid!, createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS));
      if (!owned || owned.descendants.length === 0) throw new Error("Cannot inspect the isolated native runtime ownership");
      const ping = vi.spyOn(clients[0], "ping").mockRejectedValueOnce(new Error("Controlled native-test liveness failure"));
      const failure = backends[0].probeHealth(undefined, "controlled-native-test");
      // This check observes the real fencing and replacement completion, not a wall-clock polling budget.
      await Promise.all([recovered, expect(failure).resolves.toBe(false)]);
      ping.mockRestore();
      expect(created).toBe(2);
      expect(manager.getBackendStatus()).toMatchObject({ state: "ready", connection: "connected", recoveryCount: 1 });
      expect(manager.getBackendStatus().pid).not.toBe(oldPid);
      const identities = [owned.root, ...owned.descendants];
      const statuses = await getProcessIdentityStatuses(identities, createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS));
      for (const identity of identities) expect(["exited", "replaced"]).toContain(statuses.get(identity));
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(telemetryStore.querySpans({ name: "backend.fence.phase" }).length).toBeGreaterThan(0);
      expect(telemetryStore.querySpans({ name: "backend.recover" })[0]?.metadata).toMatchObject({ outcome: "recovered" });
    } finally {
      unsubscribe();
      vi.restoreAllMocks();
      try {
        await manager.gracefulShutdown();
      } finally {
        const cleanup = await Promise.allSettled([...backends.map((backend) => backend.fence()), stopChild(unrelated)]);
        const errors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (errors.length > 0) throw new AggregateError(errors, "Native recovery test cleanup failed");
      }
    }
  }, 180_000);
});

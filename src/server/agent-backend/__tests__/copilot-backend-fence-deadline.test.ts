import { ChildProcess, type ExecFileOptions } from "node:child_process";
import { CopilotClient } from "@github/copilot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "../../deadline.js";
import { CopilotBackend } from "../copilot-backend.js";
import { RUNTIME_FENCE_BUDGET_MS, type RuntimeFenceObservation } from "../runtime-fence.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: execFileMock,
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
  execFileMock.mockReset();
});

async function fixture(snapshotLatency = 6_000) {
  const child = Object.assign(new ChildProcess(), { pid: 100 });
  const client = new CopilotClient();
  vi.spyOn(client, "start").mockImplementation(async () => { Reflect.set(client, "cliProcess", child); });
  const backend = new CopilotBackend(client, { localStdioOwnership: true });
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const table = new Map([[100, "100 1 1000"], [101, "101 100 1001"]]);
  for (let pid = 102; pid < 122; pid++) table.set(pid, `${pid} 101 ${1000 + pid}`);
  let snapshots = 0;
  const killed: number[] = [];
  execFileMock.mockImplementation((command: string, args: string[], options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (command === "powershell.exe") {
      snapshots++;
      // Initial ownership capture is immediate. All fencing snapshots simulate a loaded host.
      const latency = snapshots === 1 ? 0 : snapshotLatency;
      const timeout = Number(options.timeout);
      const finish = () => callback(latency > timeout ? new Error("CIM snapshot timed out") : null,
        [...table.values()].join("\r\n"), "");
      if (latency === 0) finish();
      else setTimeout(finish, Math.min(latency, timeout));
    } else {
      expect(command).toBe("taskkill");
      const pid = Number(args[3]);
      expect(args.slice(0, 3)).toEqual(["/T", "/F", "/PID"]);
      killed.push(pid);
      setTimeout(() => {
        if (pid === 101) for (const key of table.keys()) { if (key !== 100) table.delete(key); }
        else {
          table.delete(pid);
          Reflect.set(child, "exitCode", 0);
          child.emit("exit", 0, null);
        }
        callback(null, "", "");
      }, 1_000);
    }
    return child;
  });
  await backend.start();
  return { backend, child, killed, getSnapshots: () => snapshots };
}

describe("fencing through the real platform helper with mocked Windows side effects", () => {
  it("handles six-second snapshots and twenty MCP descendants without repeated subtree scans", async () => {
    const { backend, killed, getSnapshots } = await fixture();
    const phases: RuntimeFenceObservation[] = [];
    const deadline = createDeadline(RUNTIME_FENCE_BUDGET_MS);
    const fence = backend.fence({ deadline, onPhase: (phase) => phases.push(phase) });
    expect(backend.fence({ deadline: createDeadline(1_000) })).toBe(fence);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(fence).resolves.toBeUndefined();
    expect(killed).toEqual([101, 100]);
    expect(getSnapshots()).toBe(5); // One ownership capture, two snapshots per terminated subtree.
    expect(phases.filter((phase) => phase.phase === "snapshot").map((phase) => phase.durationMs)).toEqual([6_000, 6_000]);
    expect(phases.every((phase) => phase.outcome === "completed")).toBe(true);
    await expect(backend.start()).rejects.toThrow("fenced");
  });

  it("honors an explicit short deadline and never resets it for a later caller", async () => {
    const { backend, killed } = await fixture();
    const phases: RuntimeFenceObservation[] = [];
    const fence = backend.fence({ deadline: createDeadline(5_000), onPhase: (phase) => phases.push(phase) });
    const failed = expect(fence).rejects.toThrow("Runtime fencing failed");
    expect(backend.fence({ deadline: createDeadline(RUNTIME_FENCE_BUDGET_MS) })).toBe(fence);
    await vi.advanceTimersByTimeAsync(6_000);
    await failed;
    expect(killed).toEqual([]);
    expect(phases.at(-1)).toMatchObject({ phase: "snapshot", outcome: "failed" });
    await expect(backend.start()).rejects.toThrow("fenced");

    // The snapshot was only too slow for that deadline; a later attempt with a fresh budget can still prove the runtime gone.
    const retry = backend.fence({ deadline: createDeadline(RUNTIME_FENCE_BUDGET_MS) });
    expect(retry).not.toBe(fence);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(retry).resolves.toBeUndefined();
    expect(killed).toEqual([101, 100]);
    await expect(backend.start()).rejects.toThrow("fenced");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeLifecycleBusyState,
  findLifecycleBusyState,
  lifecycleBusyToolFailure,
  writeRestartSignalOrRollback,
  LIFECYCLE_EXCLUSIVE_JOB_TYPES,
  type LifecycleJobLookup,
} from "../restart-inflight.js";
import {
  beginRestartPending,
  clearRestartPending,
  configureRestartStateStore,
  forceClearRestartPending,
  isRestartPending,
  refreshRestartState,
} from "../restart-controller.js";
import { isRestartAlreadyInFlight, writeRestartState } from "../restart-state.js";
import { consumeRestartSignalFile } from "../restart-signal.js";
import type { ManagementJob, ManagementJobType } from "../management-job-store.js";
import { makeTestDir, makeTestRuntimePaths } from "./helpers.js";

function job(overrides: Partial<ManagementJob> = {}): ManagementJob {
  return {
    id: "job-1",
    type: "staging_deploy",
    status: "running",
    input: {},
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function jobLookup(jobs: ManagementJob[]): LifecycleJobLookup & { requestedTypes: ManagementJobType[][] } {
  const requestedTypes: ManagementJobType[][] = [];
  return {
    requestedTypes,
    listActive(types?: readonly ManagementJobType[]) {
      requestedTypes.push([...(types ?? [])]);
      return jobs;
    },
  };
}

function emptyDataDir(): string {
  const dataDir = join(makeTestDir("restart-inflight"), "data");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

describe("findLifecycleBusyState", () => {
  it("returns null when no job is active and no restart is on disk", () => {
    expect(findLifecycleBusyState({
      dataDir: emptyDataDir(),
      managementJobStore: jobLookup([]),
    })).toBeNull();
  });

  it("only asks the store about job types that end in a cutover", () => {
    const lookup = jobLookup([]);
    findLifecycleBusyState({ dataDir: emptyDataDir(), managementJobStore: lookup });
    expect(lookup.requestedTypes).toEqual([[...LIFECYCLE_EXCLUSIVE_JOB_TYPES]]);
    expect(LIFECYCLE_EXCLUSIVE_JOB_TYPES).toEqual(["self_update", "staging_deploy"]);
  });

  it("reports an active management job in preference to disk state", () => {
    const dataDir = emptyDataDir();
    writeFileSync(join(dataDir, "restart.signal"), "{}");

    const busy = findLifecycleBusyState({
      dataDir,
      managementJobStore: jobLookup([job({ type: "self_update", status: "queued" })]),
    });

    expect(busy).toEqual({ reason: "management_job", job: expect.objectContaining({ type: "self_update" }) });
    expect(describeLifecycleBusyState(busy!)).toBe("A self_update management job is queued");
  });

  it("falls back to on-disk restart state when no job is active", () => {
    const dataDir = emptyDataDir();
    writeFileSync(join(dataDir, "restart.signal"), "{}");

    const busy = findLifecycleBusyState({ dataDir, managementJobStore: jobLookup([]) });

    expect(busy).toEqual({ reason: "restart_in_flight" });
    expect(describeLifecycleBusyState(busy!)).toBe("A restart is already pending");
  });

  it("still answers without a management job store", () => {
    expect(findLifecycleBusyState({ dataDir: emptyDataDir() })).toBeNull();
    expect(findLifecycleBusyState({ dataDir: null, managementJobStore: jobLookup([]) })).toBeNull();
  });
});

describe("lifecycleBusyToolFailure", () => {
  it("returns a terminal, non-retryable envelope that tells the agent to stop", () => {
    const stagingDir = makeTestDir("restart-inflight-telemetry");
    const result = lifecycleBusyToolFailure({
      busy: { reason: "restart_in_flight" },
      retryTarget: "the deploy",
      toolTelemetry: { stagingDir },
    });

    expect(result.resultType).toBe("failure");
    expect(result.terminal).toBe(true);
    expect(result.toolNextAction).toBe("respond");
    expect(result.retryable).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.textResultForLlm).toContain("A restart is already pending");
    expect(result.textResultForLlm).toContain("the deploy");
    // The old wording invited polling, which is itself a restart blocker.
    expect(result.textResultForLlm).not.toContain("Wait for it to");
    expect(result.content[0].text).toContain('"nextAction":"respond"');
    expect(result.toolTelemetry).toEqual({
      bridge: { busyReason: "restart_in_flight", stagingDir },
    });
  });

  it("names the blocking job in telemetry and text", () => {
    const result = lifecycleBusyToolFailure({
      busy: { reason: "management_job", job: job({ id: "job-9", type: "staging_deploy", status: "running" }) },
      retryTarget: "the update",
    });

    expect(result.textResultForLlm).toContain("A staging_deploy management job is running");
    expect(result.toolTelemetry).toEqual({
      bridge: { busyReason: "management_job", activeJobId: "job-9", activeJobType: "staging_deploy" },
    });
  });
});

describe("request-scoped restart clears", () => {
  afterEach(async () => {
    forceClearRestartPending();
    await refreshRestartState();
    configureRestartStateStore(undefined);
  });

  it("does not let stale cleanup erase a newer restart request", async () => {
    const runtimePaths = makeTestRuntimePaths("restart-request-scope");
    configureRestartStateStore(runtimePaths);
    const first = beginRestartPending();
    const second = beginRestartPending();

    expect(clearRestartPending(first.requestId)).toBe(false);
    expect((await refreshRestartState()).requestId).toBe(second.requestId);

    expect(clearRestartPending(second.requestId)).toBe(true);
    expect((await refreshRestartState()).phase).toBe("idle");
  });

  it("re-checks the persisted request before a queued clear deletes state", async () => {
    const runtimePaths = makeTestRuntimePaths("restart-request-persisted-scope");
    configureRestartStateStore(runtimePaths);
    const request = beginRestartPending();
    await refreshRestartState();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "launcher-owned-new-request",
      phase: "restarting",
      requestedAt: new Date().toISOString(),
      waitingSessions: 0,
      launcherHeartbeatAt: new Date().toISOString(),
    });

    expect(clearRestartPending(request.requestId)).toBe(true);
    expect(await refreshRestartState()).toMatchObject({
      requestId: "launcher-owned-new-request",
      phase: "restarting",
    });
  });

  it("clears an invalid claimed signal from the disk-derived in-flight gate", async () => {
    const runtimePaths = makeTestRuntimePaths("restart-invalid-claim-scope");
    configureRestartStateStore(runtimePaths);
    const request = beginRestartPending();
    await refreshRestartState();
    const signalFile = join(runtimePaths.dataDir, "restart.signal");
    const inProgressFile = join(runtimePaths.dataDir, "restart-in-progress.json");
    writeFileSync(signalFile, JSON.stringify({
      requestId: request.requestId,
      validationMode: "deploy",
      releaseCandidate: {
        id: "slot-invalid",
        root: "",
        commitSha: "abc123",
        source: "self_update",
        dependencyHash: "deps123",
      },
    }));

    const claim = consumeRestartSignalFile(signalFile, inProgressFile);
    expect(claim).toMatchObject({
      status: "invalid",
      requestId: request.requestId,
    });
    expect(isRestartAlreadyInFlight(runtimePaths.dataDir)).toBe(true);

    expect(clearRestartPending(request.requestId)).toBe(true);
    rmSync(inProgressFile);
    await refreshRestartState();
    expect(isRestartAlreadyInFlight(runtimePaths.dataDir)).toBe(false);
  });
});

describe("writeRestartSignalOrRollback", () => {
  afterEach(async () => {
    forceClearRestartPending();
    await refreshRestartState();
  });

  it("publishes the restart to disk in the same tick it marks it pending", () => {
    // Callers gate on disk state (isRestartAlreadyInFlight), not on the
    // process-local isRestartPending(). That is only equivalent because the
    // signal file lands synchronously — this test is deliberately non-async so
    // nothing can interleave between the two observations below.
    const dataDir = emptyDataDir();
    const signalFile = join(dataDir, "restart.signal");
    expect(isRestartAlreadyInFlight(dataDir)).toBe(false);
    expect(isRestartPending()).toBe(false);

    writeRestartSignalOrRollback(signalFile, "operational", "restart-inflight-test");

    expect(isRestartPending(), "in-memory pending").toBe(true);
    expect(existsSync(signalFile), "signal file written in the same tick").toBe(true);
    expect(isRestartAlreadyInFlight(dataDir), "visible to the disk-derived gate").toBe(true);
    expect(JSON.parse(readFileSync(signalFile, "utf8"))).toMatchObject({
      validationMode: "operational",
      source: "restart-inflight-test",
      requestId: expect.any(String),
    });
  });

  it("rolls the pending state back when the signal write fails", () => {
    // An unwritable path stands in for a failed write: the server must not be
    // left claiming a restart the launcher will never see.
    const dataDir = emptyDataDir();
    const unwritable = join(dataDir, "missing-dir", "restart.signal");

    expect(() => writeRestartSignalOrRollback(unwritable, "operational", "restart-inflight-test")).toThrow();
    expect(isRestartPending()).toBe(false);
    expect(isRestartAlreadyInFlight(dataDir)).toBe(false);
  });
});

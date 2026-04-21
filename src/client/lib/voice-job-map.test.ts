import { describe, expect, it } from "vitest";
import type { VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";
import { clearOwnedVoiceJobs, replaceVoiceJob, shouldHandleDraftVoiceTarget } from "./voice-job-map";

function createJob(overrides: Partial<VoiceBackgroundJob> & Pick<VoiceBackgroundJob, "composerKey" | "status" | "submitMode">): VoiceBackgroundJob {
  return {
    serverOwned: true,
    ...overrides,
  };
}

describe("voice job map helpers", () => {
  it("moves a draft voice job into its target session in one update", () => {
    const jobs = {
      "draft:quickchat": createJob({
        composerKey: "draft:quickchat",
        status: "uploading",
        submitMode: "autosend",
        originComposerKey: "draft:quickchat",
      }),
    };

    expect(replaceVoiceJob(jobs, "job-1", "draft:quickchat", createJob({
      composerKey: "session-1",
      status: "accepted",
      submitMode: "autosend",
      serverJobId: "job-1",
      originComposerKey: "draft:quickchat",
      targetSessionId: "session-1",
    }), "job-1")).toEqual({
      "session-1": createJob({
        composerKey: "session-1",
        status: "accepted",
        submitMode: "autosend",
        serverJobId: "job-1",
        originComposerKey: "draft:quickchat",
        targetSessionId: "session-1",
      }),
    });
  });

  it("does not clear a newer draft upload that is not owned by the older server job", () => {
    const jobs = {
      "draft:quickchat": createJob({
        composerKey: "draft:quickchat",
        status: "uploading",
        submitMode: "autosend",
      }),
    };

    expect(replaceVoiceJob(jobs, "job-1", "draft:quickchat", createJob({
      composerKey: "session-1",
      status: "transcribing",
      submitMode: "autosend",
      serverJobId: "job-1",
      originComposerKey: "draft:quickchat",
      targetSessionId: "session-1",
    }))).toEqual({
      "draft:quickchat": createJob({
        composerKey: "draft:quickchat",
        status: "uploading",
        submitMode: "autosend",
      }),
      "session-1": createJob({
        composerKey: "session-1",
        status: "transcribing",
        submitMode: "autosend",
        serverJobId: "job-1",
        originComposerKey: "draft:quickchat",
        targetSessionId: "session-1",
      }),
    });
  });

  it("blocks stale draft remaps once the reused draft key has new local content", () => {
    expect(shouldHandleDraftVoiceTarget(undefined, "job-1", null, false, true)).toBe(false);
  });

  it("allows draft remaps while the local upload still belongs to the same server job", () => {
    expect(shouldHandleDraftVoiceTarget(
      createJob({
        composerKey: "draft:quickchat",
        status: "uploading",
        submitMode: "autosend",
      }),
      "job-1",
      "job-1",
      false,
      false,
    )).toBe(true);
  });

  it("allows trusted draft recovery when the draft is still empty", () => {
    expect(shouldHandleDraftVoiceTarget(undefined, "job-1", null, true, false)).toBe(true);
  });

  it("clears both origin and target keys for terminal snapshots", () => {
    const jobs = {
      "draft:quickchat": createJob({
        composerKey: "draft:quickchat",
        status: "uploading",
        submitMode: "autosend",
      }),
      "session-1": createJob({
        composerKey: "session-1",
        status: "sending",
        submitMode: "autosend",
        serverJobId: "job-1",
      }),
    };

    expect(clearOwnedVoiceJobs(
      jobs,
      { composerKey: "draft:quickchat", serverJobId: "job-1", claimedServerJobId: "job-1" },
      { composerKey: "session-1", serverJobId: "job-1" },
    )).toEqual({});
  });
});

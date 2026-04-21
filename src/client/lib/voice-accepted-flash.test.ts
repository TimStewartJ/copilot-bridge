import { describe, expect, it } from "vitest";
import {
  shouldClearAcceptedFlashHandoff,
  shouldFlashAcceptedHandoff,
  shouldFlashAcceptedStatus,
  shouldKeepAcceptedFlash,
  updateAcceptedFlashHandoff,
} from "./voice-accepted-flash";

describe("voice accepted flash helpers", () => {
  it("flashes when an uploading job becomes accepted in the same composer", () => {
    expect(shouldFlashAcceptedStatus(
      {
        composerKey: "session-1",
        status: "uploading",
        serverOwned: true,
        originComposerKey: "session-1",
      },
      {
        composerKey: "session-1",
        status: "accepted",
        serverOwned: true,
        serverJobId: "job-1",
        originComposerKey: "session-1",
      },
    )).toBe(true);
  });

  it("flashes when a draft upload is remapped into its target session", () => {
    expect(shouldFlashAcceptedStatus(
      {
        composerKey: "draft:task-1",
        status: "uploading",
        serverOwned: true,
        originComposerKey: "draft:task-1",
      },
      {
        composerKey: "session-2",
        status: "accepted",
        serverOwned: true,
        serverJobId: "job-2",
        originComposerKey: "draft:task-1",
      },
    )).toBe(true);
  });

  it("does not flash for recovered accepted jobs without a local upload transition", () => {
    expect(shouldFlashAcceptedStatus(
      null,
      {
        composerKey: "session-1",
        status: "accepted",
        serverOwned: true,
        serverJobId: "job-1",
        originComposerKey: "session-1",
      },
    )).toBe(false);
  });

  it("flashes after a draft-to-session handoff when the first visible state is already transcribing", () => {
    expect(shouldFlashAcceptedHandoff(
      "draft:quickchat",
      "session-1",
      {
        composerKey: "session-1",
        status: "transcribing",
        serverOwned: true,
        serverJobId: "job-1",
        originComposerKey: "draft:quickchat",
      },
    )).toBe(true);
  });

  it("does not flash for unrelated session changes", () => {
    expect(shouldFlashAcceptedHandoff(
      "session-1",
      "session-2",
      {
        composerKey: "session-2",
        status: "transcribing",
        serverOwned: true,
        serverJobId: "job-1",
        originComposerKey: "draft:quickchat",
      },
    )).toBe(false);
  });

  it("preserves the draft handoff across a transient null-job gap", () => {
    let pendingHandoff = updateAcceptedFlashHandoff("draft:quickchat", "session-1", null);

    expect(shouldFlashAcceptedHandoff(
      pendingHandoff?.originComposerKey ?? null,
      "session-1",
      null,
    )).toBe(false);

    pendingHandoff = updateAcceptedFlashHandoff("session-1", "session-1", pendingHandoff);

    const currentJob = {
      composerKey: "session-1",
      status: "transcribing" as const,
      serverOwned: true,
      serverJobId: "job-1",
      originComposerKey: "draft:quickchat",
    };
    expect(shouldFlashAcceptedHandoff(
      pendingHandoff?.originComposerKey ?? null,
      "session-1",
      currentJob,
    )).toBe(true);
    expect(shouldClearAcceptedFlashHandoff(pendingHandoff, "session-1", currentJob)).toBe(true);
  });

  it("keeps the flash only while the same server job remains active", () => {
    expect(shouldKeepAcceptedFlash("job-1", {
      composerKey: "session-1",
      status: "transcribing",
      serverOwned: true,
      serverJobId: "job-1",
      originComposerKey: "session-1",
    })).toBe(true);

    expect(shouldKeepAcceptedFlash("job-1", {
      composerKey: "session-2",
      status: "sending",
      serverOwned: true,
      serverJobId: "job-2",
      originComposerKey: "session-2",
    })).toBe(false);
  });
});

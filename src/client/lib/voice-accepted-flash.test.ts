import { describe, expect, it } from "vitest";
import {
  shouldClearAcceptedFlashHandoff,
  shouldFlashAcceptedHandoff,
  shouldFlashAcceptedStatus,
  shouldKeepAcceptedFlash,
  updateAcceptedFlashHandoff,
} from "./voice-accepted-flash";

describe("voice accepted flash helpers", () => {
  it("flashes for upload→accepted transitions in same or remapped composer, not for recovered jobs", () => {
    // same composer: uploading → accepted → flash
    expect(shouldFlashAcceptedStatus(
      { composerKey: "session-1", status: "uploading", serverOwned: true, originComposerKey: "session-1" },
      { composerKey: "session-1", status: "accepted", serverOwned: true, serverJobId: "job-1", originComposerKey: "session-1" },
    )).toBe(true);

    // draft remapped to target session → flash
    expect(shouldFlashAcceptedStatus(
      { composerKey: "draft:task-1", status: "uploading", serverOwned: true, originComposerKey: "draft:task-1" },
      { composerKey: "session-2", status: "accepted", serverOwned: true, serverJobId: "job-2", originComposerKey: "draft:task-1" },
    )).toBe(true);

    // no previous local job (recovered accepted) → no flash
    expect(shouldFlashAcceptedStatus(
      null,
      { composerKey: "session-1", status: "accepted", serverOwned: true, serverJobId: "job-1", originComposerKey: "session-1" },
    )).toBe(false);
  });

  it("flashes after a draft-to-session handoff when the first visible state is already transcribing, not for unrelated session changes", () => {
    // draft origin → target session with transcribing job → flash
    expect(shouldFlashAcceptedHandoff(
      "draft:quickchat",
      "session-1",
      { composerKey: "session-1", status: "transcribing", serverOwned: true, serverJobId: "job-1", originComposerKey: "draft:quickchat" },
    )).toBe(true);

    // unrelated session change → no flash
    expect(shouldFlashAcceptedHandoff(
      "session-1",
      "session-2",
      { composerKey: "session-2", status: "transcribing", serverOwned: true, serverJobId: "job-1", originComposerKey: "draft:quickchat" },
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

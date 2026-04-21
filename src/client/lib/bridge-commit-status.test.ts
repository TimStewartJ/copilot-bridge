import { describe, expect, it } from "vitest";
import {
  describeBridgeOverview,
  describeLocalVsRemote,
  describeRunningVsLocal,
  getBridgeComparisonKind,
} from "./bridge-commit-status.js";

describe("bridge commit status helpers", () => {
  it("classifies commit comparisons", () => {
    expect(getBridgeComparisonKind({ status: "ok", ahead: 0, behind: 0 })).toBe("same");
    expect(getBridgeComparisonKind({ status: "ok", ahead: 2, behind: 0 })).toBe("ahead");
    expect(getBridgeComparisonKind({ status: "ok", ahead: 0, behind: 3 })).toBe("behind");
    expect(getBridgeComparisonKind({ status: "ok", ahead: 1, behind: 1 })).toBe("diverged");
    expect(getBridgeComparisonKind({ status: "unavailable", error: "boom" })).toBe("unavailable");
  });

  it("describes when local HEAD is behind upstream", () => {
    expect(describeLocalVsRemote({ status: "ok", ahead: 0, behind: 2 }, false)).toEqual({
      label: "Behind by 2",
      detail: "Tracked upstream has 2 commits that are not in local HEAD.",
      tone: "warning",
    });
  });

  it("describes when the running bridge needs a restart", () => {
    expect(describeRunningVsLocal({ status: "ok", ahead: 0, behind: 1 }, false)).toEqual({
      label: "Restart needed",
      detail: "The running bridge is 1 commit behind local HEAD.",
      tone: "warning",
    });
  });

  it("reports aligned and attention states in the overview", () => {
    expect(describeBridgeOverview({
      local: {
        status: "ok",
        ref: "HEAD",
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        message: "Local",
      },
      remote: {
        status: "ok",
        ref: "origin/main",
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        message: "Remote",
      },
      running: {
        status: "ok",
        ref: "HEAD @ server start",
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        message: "Running",
      },
      comparisons: {
        localVsRemote: { status: "ok", ahead: 0, behind: 0 },
        runningVsLocal: { status: "ok", ahead: 0, behind: 0 },
      },
    }, false)).toEqual({
      label: "All aligned",
      detail: "Local, upstream, and running bridge commits all match.",
      tone: "success",
    });

    expect(describeBridgeOverview({
      local: {
        status: "ok",
        ref: "HEAD",
        sha: "1111111111111111111111111111111111111111",
        shortSha: "1111111",
        message: "Local",
      },
      remote: {
        status: "ok",
        ref: "origin/main",
        sha: "2222222222222222222222222222222222222222",
        shortSha: "2222222",
        message: "Remote",
      },
      running: {
        status: "ok",
        ref: "HEAD @ server start",
        sha: "3333333333333333333333333333333333333333",
        shortSha: "3333333",
        message: "Running",
      },
      comparisons: {
        localVsRemote: { status: "ok", ahead: 0, behind: 2 },
        runningVsLocal: { status: "ok", ahead: 0, behind: 1 },
      },
    }, false)).toEqual({
      label: "Attention needed",
      detail: "Local HEAD is not fully aligned with upstream or the running bridge.",
      tone: "warning",
    });
  });
});

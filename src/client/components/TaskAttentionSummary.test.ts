import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReactDomHarness, type ReactDomHarness } from "../test-react-harness";
import type { TaskRowSignal, TaskRowSignalKind } from "../task-row-signals";
import TaskAttentionSummary from "./TaskAttentionSummary";

const mark = (kind: TaskRowSignalKind): TaskRowSignal => ({ kind, label: kind, shortLabel: kind, tone: "faint", status: "review" });

describe("task attention summary", () => {
  let harness: ReactDomHarness;
  beforeEach(async () => { harness = await createReactDomHarness(); });
  afterEach(async () => { await harness.cleanup(); });
  it("counts every attention mark the rows show, including revisits", async () => {
    await harness.render(createElement(TaskAttentionSummary, { signals: new Map([
      ["a", mark("needs-input")], ["b", mark("needs-look")], ["c", mark("unread")], ["d", mark("unread")],
      ["e", mark("follow-up-overdue")], ["f", mark("follow-up-due")], ["g", mark("stalled")], ["h", null],
    ]) }));
    expect(harness.dom.container.textContent).toBe("1 needs an answer · 1 stalled · 1 needs a look · 2 new replies · 2 to revisit");
  });
  it("renders nothing when no task is marked", async () => {
    await harness.render(createElement(TaskAttentionSummary, { signals: new Map([["a", null]]) }));
    expect(harness.dom.container.textContent).toBe("");
  });
});

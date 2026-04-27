import { describe, expect, it } from "vitest";
import { createTaskCompletionFeedback } from "./task-completion-feedback";

describe("createTaskCompletionFeedback", () => {
  it("builds concise completion copy and keeps done-when separate", () => {
    expect(createTaskCompletionFeedback({
      task: {
        id: "task-1",
        title: "Ship task",
        doneWhen: "Merged and deployed",
        pullRequests: [{ provider: "github", repoName: "repo", prId: 42 }],
      },
      previousStatus: "active",
      checklistItems: [{ done: true }, { done: true }],
      linkedSessions: [{ busy: false, runState: "idle" }, { busy: false, runState: "idle" }],
      pullRequests: [{ status: "completed" }],
    })).toEqual({
      taskId: "task-1",
      taskTitle: "Ship task",
      previousStatus: "active",
      summary: "2 of 2 checklist items complete • 2 linked sessions • 1 linked PR",
      doneWhenCopy: "Done when: Merged and deployed",
    });
  });

  it("falls back to raw linked PR counts when enrichment is unavailable", () => {
    expect(createTaskCompletionFeedback({
      task: {
        id: "task-2",
        title: "Close loop",
        doneWhen: undefined,
        pullRequests: [
          { provider: "github", repoName: "repo", prId: 1 },
          { provider: "github", repoName: "repo", prId: 2 },
        ],
      },
      previousStatus: "paused",
    })).toMatchObject({
      summary: "No checklist items • 0 linked sessions • 2 linked PRs",
      doneWhenCopy: undefined,
      previousStatus: "paused",
    });
  });
});

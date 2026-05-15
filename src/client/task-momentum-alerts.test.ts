import { describe, expect, it } from "vitest";
import type { EnrichedPR, Session, Task } from "./api";
import { getTaskAlertChips } from "./components/task-momentum-alerts";

const BASE_TASK: Task = {
  id: "task-1",
  title: "Refresh header",
  kind: "task",
  muted: false,
  status: "active",
  notes: "",
  priority: 3,
  order: 0,
  createdAt: "2026-05-01T09:00:00.000Z",
  updatedAt: "2026-05-01T11:00:00.000Z",
  sessionIds: [],
  workItems: [],
  pullRequests: [],
};

function makeSession(overrides: Partial<Session>): Session {
  return {
    sessionId: "session-1",
    runState: "idle",
    busy: false,
    archived: false,
    modifiedTime: "2026-05-01T11:00:00.000Z",
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

function makePr(overrides: Partial<EnrichedPR>): EnrichedPR {
  return {
    repoId: "repo-1",
    repoName: "copilot-bridge",
    prId: 42,
    provider: "github",
    title: "Header polish",
    status: "active",
    createdBy: "copilot",
    reviewerCount: 1,
    url: "https://example.com/pr/42",
    ...overrides,
  };
}

describe("getTaskAlertChips", () => {
  it("caps alerts to the three highest-signal states", () => {
    const task: Task = {
      ...BASE_TASK,
      nextTouchAt: "2026-04-01T09:00:00.000Z",
      waitingOn: "Design review",
    };
    const sessions = [
      makeSession({ sessionId: "stalled-1", runState: "stalled", summary: "Polish pass", modifiedTime: "2026-05-01T10:30:00.000Z" }),
      makeSession({ sessionId: "busy-1", runState: "busy", summary: "Streaming", modifiedTime: "2026-05-01T10:20:00.000Z" }),
      makeSession({ sessionId: "unread-1", summary: "Needs review", modifiedTime: "2026-05-01T10:40:00.000Z" }),
    ];

    const chips = getTaskAlertChips({
      task,
      sessions,
      pullRequests: [makePr({ prId: 99 })],
      isUnread: (sessionId) => sessionId === "unread-1",
    });

    expect(chips.map((chip) => chip.kind)).toEqual([
      "follow-up-overdue",
      "waiting",
      "session-stalled",
    ]);
  });

  it("treats the active session as already read and falls back to active PRs", () => {
    const chips = getTaskAlertChips({
      task: BASE_TASK,
      sessions: [
        makeSession({ sessionId: "active-chat", summary: "Current chat", modifiedTime: "2026-05-01T12:00:00.000Z" }),
        makeSession({ sessionId: "other-chat", summary: "Other chat", modifiedTime: "2026-05-01T11:30:00.000Z" }),
      ],
      activeSessionId: "active-chat",
      isUnread: () => true,
      pullRequests: [makePr({ prId: 10 }), makePr({ prId: 11 })],
    });

    expect(chips.map((chip) => chip.kind)).toEqual([
      "session-unread",
      "active-pr",
      "needs-decision",
    ]);
    expect(chips[0]?.label).toBe("Unread activity");
  });

  it("surfaces paused tasks even without an explicit waiting reason", () => {
    const chips = getTaskAlertChips({
      task: {
        ...BASE_TASK,
        status: "paused",
        nextAction: "Resume after infra window",
      },
      sessions: [],
    });

    expect(chips.map((chip) => chip.kind)).toContain("paused");
  });
});

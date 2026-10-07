import { describe, expect, it } from "vitest";
import type { Session, Task } from "../api";
import { listUnreadSessions } from "./unread-sessions";

type ListedTask = Pick<Task, "id" | "title" | "status" | "muted" | "activeSessionIds">;

const READ_AT = "2026-09-30T12:00:00.000Z";
const BEFORE_READ = "2026-09-30T11:00:00.000Z";
const AFTER_READ = "2026-09-30T13:00:00.000Z";

function createSession(sessionId: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId,
    summary: `Chat ${sessionId}`,
    runState: "idle",
    lastActivityAt: AFTER_READ,
    deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
    ...overrides,
  };
}

function createTask(id: string, overrides: Partial<ListedTask> = {}): ListedTask {
  return { id, title: `Task ${id}`, status: "active", muted: false, activeSessionIds: [], ...overrides };
}

/** Every chat was last read at READ_AT, except the ids listed as never read. */
function readState(neverRead: string[] = []) {
  return (sessionId: string, activityTime?: string) => {
    if (!activityTime) return false;
    return neverRead.includes(sessionId) || Date.parse(activityTime) > Date.parse(READ_AT);
  };
}

function ids(entries: ReturnType<typeof listUnreadSessions>): string[] {
  return entries.map((entry) => entry.session.sessionId);
}

describe("listUnreadSessions", () => {
  it("lists idle chats with unseen results, newest first", () => {
    const entries = listUnreadSessions({
      sessions: [
        createSession("older", { lastActivityAt: "2026-09-30T13:00:00.000Z" }),
        createSession("read", { lastActivityAt: BEFORE_READ }),
        createSession("newest", { lastActivityAt: "2026-09-30T15:00:00.000Z" }),
        createSession("never-read", { lastActivityAt: BEFORE_READ }),
        createSession("tie-b", { lastActivityAt: "2026-09-30T14:00:00.000Z" }),
        createSession("tie-a", { lastActivityAt: "2026-09-30T14:00:00.000Z" }),
      ],
      tasks: [],
      isUnread: readState(["never-read"]),
    });

    expect(ids(entries)).toEqual(["newest", "tie-a", "tie-b", "older", "never-read"]);
    expect(entries.every((entry) => entry.task === undefined)).toBe(true);
  });

  it("leaves out chats that are working, archived, open behind the list, or without activity", () => {
    const entries = listUnreadSessions({
      sessions: [
        createSession("busy", { runState: "busy" }),
        createSession("stalled", { runState: "stalled" }),
        createSession("archived", { archived: true }),
        createSession("open"),
        createSession("no-activity", { lastActivityAt: undefined }),
        createSession("unread"),
      ],
      tasks: [],
      isUnread: readState(),
      activeSessionId: "open",
    });

    expect(ids(entries)).toEqual(["unread"]);
  });

  it("opens a chat under its first active, unmuted task, else its archived one, and keeps muted tasks quiet", () => {
    const tasks = [
      createTask("muted", { muted: true, activeSessionIds: ["shared", "only-muted"] }),
      createTask("archived", { status: "archived" }),
      createTask("archived-muted", { status: "archived", muted: true }),
      createTask("first", { activeSessionIds: ["shared"] }),
      createTask("second", { activeSessionIds: ["shared"] }),
    ];
    const entries = listUnreadSessions({
      sessions: [
        createSession("shared", { linkedTaskIds: ["muted", "first", "second"] }),
        createSession("only-muted", { linkedTaskIds: ["muted"] }),
        // An archived chat's task lists it only through the link on the chat itself.
        createSession("only-archived-task", { linkedTaskIds: ["archived"] }),
        createSession("archived-and-muted-active", { linkedTaskIds: ["archived", "muted"] }),
        createSession("only-archived-muted", { linkedTaskIds: ["archived-muted"] }),
        createSession("unknown-task", { linkedTaskIds: ["not-loaded"] }),
        createSession("quick"),
      ],
      tasks,
      isUnread: readState(),
    });

    expect(entries.map((entry) => [entry.session.sessionId, entry.task?.id])).toEqual([
      ["only-archived-task", "archived"],
      ["quick", undefined],
      ["shared", "first"],
    ]);
  });

  it("lists a named task's unread chats even when the task is muted", () => {
    const tasks = [
      createTask("muted", { muted: true, activeSessionIds: ["in-muted"] }),
      createTask("other", { activeSessionIds: ["in-other"] }),
    ];
    const sessions = [
      createSession("in-muted", { linkedTaskIds: ["muted"] }),
      createSession("in-other", { linkedTaskIds: ["other"] }),
      createSession("quick"),
    ];

    const scoped = listUnreadSessions({ sessions, tasks, isUnread: readState(), taskId: "muted" });
    expect(scoped.map((entry) => [entry.session.sessionId, entry.task?.id])).toEqual([["in-muted", "muted"]]);
    expect(listUnreadSessions({ sessions, tasks, isUnread: readState(), taskId: "missing" })).toEqual([]);
    expect(listUnreadSessions({ sessions, tasks, isUnread: readState(), taskId: "" })).toEqual([]);
  });
});

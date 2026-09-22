import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Session, Task } from "../api";
import {
  COMPONENT_IMPORT_WARMUP_TIMEOUT_MS,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../test-react-harness";

const navigate = vi.fn();
const data = vi.hoisted(() => ({
  sessions: [] as unknown[],
  archived: [] as unknown[],
  archivedRequested: [] as boolean[],
  tasks: [] as unknown[],
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../hooks/queries/useSessions", () => ({
  useSessionsQuery: (includeArchived: boolean, options: { enabled?: boolean } = {}) => {
    if (includeArchived) data.archivedRequested.push(options.enabled !== false);
    return includeArchived
      ? { data: options.enabled === false ? undefined : data.archived, isSuccess: options.enabled !== false }
      : { data: data.sessions, isSuccess: true };
  },
}));
vi.mock("../hooks/queries/useTasks", () => ({ useTasksQuery: () => ({ data: data.tasks }) }));

const SESSION_ID = "aaaaaaaa-1111-4000-8000-000000000001";

function session(overrides: Partial<Session>): Session {
  return { sessionId: SESSION_ID, deferSummary: { count: 0, runningCount: 0, nextRunAt: null }, ...overrides };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    title: "Tellus Expeditions",
    kind: "task",
    muted: false,
    deferred: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    sessionIds: [SESSION_ID],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

let MessageBubble: typeof import("./MessageBubble").default;
let reference: typeof import("./BridgeReference");

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: MessageBubble } = await import("./MessageBubble"));
    reference = await import("./BridgeReference");
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

beforeEach(() => {
  navigate.mockReset();
  data.sessions = [];
  data.archived = [];
  data.archivedRequested = [];
  data.tasks = [];
});

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

function findReferences(root: unknown) {
  return findAllByTag(root, "A").filter((anchor) => getReactProps(anchor)?.["data-bridge-reference"]);
}

describe("resolveBridgeReference", () => {
  it("describes a session by its live state and routes it through its task", () => {
    const sessions = [session({ summary: "Worldgen transition fix", runState: "busy", intentText: "Running tests", linkedTaskIds: ["task-1"] })];
    const resolved = reference.resolveBridgeReference({ kind: "session", sessionId: "aaaaaaaa" }, { sessions, tasks: [task({})] });
    expect(resolved).toMatchObject({
      found: true,
      title: "Worldgen transition fix",
      tone: "running",
      detail: "Running tests",
      path: `/tasks/task-1/sessions/${SESSION_ID}`,
    });
    expect(resolved.meta).toContain("Tellus Expeditions");
  });

  it("prefers waiting over running, and unread only when idle", () => {
    const base = { tasks: [] as Task[], isUnread: () => true };
    const waiting = reference.resolveBridgeReference({ kind: "session", sessionId: SESSION_ID }, { ...base, sessions: [session({ needsUserInput: true, runState: "busy" })] });
    expect(waiting.tone).toBe("waiting");
    const unread = reference.resolveBridgeReference({ kind: "session", sessionId: SESSION_ID }, { ...base, sessions: [session({ lastActivityAt: "2026-09-18T10:00:00.000Z" })] });
    expect(unread).toMatchObject({ tone: "unread", path: `/sessions/${SESSION_ID}` });
    const archived = reference.resolveBridgeReference({ kind: "session", sessionId: SESSION_ID }, { ...base, sessions: [session({ archived: true })] });
    expect(archived.tone).toBe("archived");
  });

  it("falls back to the link's own label when the item is unknown", () => {
    const resolved = reference.resolveBridgeReference({ kind: "session", sessionId: "deadbeef" }, { sessions: [], tasks: [], label: "That deploy chat" });
    expect(resolved).toMatchObject({ found: false, title: "That deploy chat", tone: "unknown", path: "/sessions/deadbeef" });
    expect(reference.resolveBridgeReference({ kind: "session", sessionId: "deadbeef" }, { sessions: [], tasks: [] }).title).toBe("Session deadbeef");
  });

  it("summarizes a task from its sessions and momentum", () => {
    const sessions = [
      session({ needsUserInput: true }),
      session({ sessionId: "bbbbbbbb-2222-4000-8000-000000000002", runState: "busy" }),
      session({ sessionId: "cccccccc-3333-4000-8000-000000000003", runState: "busy", archived: true }),
    ];
    const tasks = [task({ sessionIds: sessions.map((entry) => entry.sessionId), nextAction: "Review biome blend" })];
    expect(reference.resolveBridgeReference({ kind: "task", taskId: "task-1" }, { sessions, tasks })).toMatchObject({
      title: "Tellus Expeditions",
      tone: "waiting",
      detail: "Next step: Review biome blend",
      meta: "1 waiting · 1 running",
      path: "/tasks/task-1",
    });
    expect(reference.resolveBridgeReference({ kind: "task", taskId: "nope" }, { sessions, tasks })).toMatchObject({ found: false, title: "Task" });
  });

  it("names docs by their last path segment", () => {
    expect(reference.resolveBridgeReference({ kind: "doc", path: "tellus/categorical-transition-plan" }, { sessions: [], tasks: [] })).toMatchObject({
      title: "categorical-transition-plan",
      meta: "tellus/categorical-transition-plan",
      path: "/docs/tellus/categorical-transition-plan",
    });
  });
});

describe("bridgeUrlTransform", () => {
  it("keeps bridge links and still sanitizes everything else", () => {
    expect(reference.bridgeUrlTransform("bridge://session/abcd1234")).toBe("bridge://session/abcd1234");
    expect(reference.bridgeUrlTransform("https://example.com/a")).toBe("https://example.com/a");
    expect(reference.bridgeUrlTransform("javascript:alert(1)")).toBe("");
  });
});

describe("Bridge references in chat messages", () => {
  it("renders an inline bridge link as a live chip that navigates in-app", async () => {
    data.sessions = [session({ summary: "Worldgen transition fix", needsUserInput: true })];
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(MessageBubble, {
        message: assistant("The [Tellus fix](bridge://session/aaaaaaaa) is waiting on you, see [the docs](https://example.com)."),
      }));
      const [chip, ...rest] = findReferences(harness.dom.container);
      expect(rest).toHaveLength(0);
      const props = getReactProps(chip)!;
      expect(props["data-bridge-reference"]).toBe("session");
      expect(props["data-bridge-reference-state"]).toBe("waiting");
      expect(props["aria-label"]).toBe("Session, Worldgen transition fix, Waiting on you");
      expect(props["data-bridge-reference-card"]).toBeUndefined();
      expect(String(props.href)).toContain(`/sessions/${SESSION_ID}`);
      expect(chip.textContent).toContain("Worldgen transition fix");

      const preventDefault = vi.fn();
      await harness.act(() => props.onClick({ button: 0, preventDefault }));
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith(`/sessions/${SESSION_ID}`);

      // A modified click keeps its browser meaning instead of navigating in place.
      navigate.mockReset();
      await harness.act(() => props.onClick({ button: 0, ctrlKey: true, preventDefault }));
      expect(navigate).not.toHaveBeenCalled();

      const ordinary = findAllByTag(harness.dom.container, "A").find((anchor) => getReactProps(anchor)?.href === "https://example.com");
      expect(ordinary).toBeDefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("turns a link alone on its line into a card, including plain app routes", async () => {
    data.tasks = [task({ nextAction: "Review biome blend", sessionIds: [] })];
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(MessageBubble, {
        message: assistant("Here it is:\n\n[Tellus](/tasks/task-1)\n\nAnything else?"),
      }));
      const [card] = findReferences(harness.dom.container);
      const props = getReactProps(card)!;
      expect(props["data-bridge-reference-card"]).toBe("true");
      expect(props["data-bridge-reference"]).toBe("task");
      expect(card.textContent).toContain("Tellus Expeditions");
      expect(card.textContent).toContain("Next step: Review biome blend");
    } finally {
      await harness.cleanup();
    }
  });

  it("only loads archived sessions for a reference the active list cannot explain", async () => {
    data.sessions = [session({ summary: "Worldgen transition fix" })];
    data.archived = [session({ sessionId: "dddddddd-4444-4000-8000-000000000004", summary: "Old archived chat", archived: true })];
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(MessageBubble, { message: assistant("See [fix](bridge://session/aaaaaaaa).") }));
      expect(data.archivedRequested.every((enabled) => enabled === false)).toBe(true);

      data.archivedRequested = [];
      await harness.render(createElement(MessageBubble, { message: assistant("See [old](bridge://session/dddddddd).") }));
      expect(data.archivedRequested).toContain(true);
      const [chip] = findReferences(harness.dom.container);
      expect(getReactProps(chip)!["data-bridge-reference-state"]).toBe("archived");
      expect(chip.textContent).toContain("Old archived chat");
    } finally {
      await harness.cleanup();
    }
  });
});

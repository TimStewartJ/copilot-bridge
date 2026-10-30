import { describe, expect, it } from "vitest";
import type { HelmMemoryEntry } from "../../../shared/helm-thinker.js";
import type { PacketBridge, ThinkerPacket } from "../thinker/context.js";
import { validatePublication } from "../thinker/publish.js";

function bridge(overrides: Partial<PacketBridge> = {}): PacketBridge {
  return {
    id: "local",
    label: "lazrik",
    ok: true,
    questions: [
      { sessionId: "s-q", requestId: "r1", kind: "user_input", question: "Install the bot login?", choices: ["Yes", "No"], allowFreeform: false, answerable: true, conversation: "Bot" },
      { sessionId: "s-form", requestId: "r2", kind: "elicitation", question: "Fill the form", answerable: false, conversation: "Form" },
    ],
    replies: [
      { sessionId: "s-r", conversation: "Flyer", activityAt: "2026-10-25T10:00:00.000Z", excerpt: "It's fixed." },
      { sessionId: "s-q", conversation: "Bot", activityAt: "2026-10-25T10:00:00.000Z" },
    ],
    due: [{ actionId: "c1", text: "Move billing" }],
    tasks: [{ taskId: "t1", title: "AWC", changed: true, tidy: ["instructions mention specific dates 4 times"] }, { taskId: "t2", title: "LA trip", changed: false }],
    working: [],
    omitted: { questions: 0, replies: 0, due: 0, tasks: 0 },
    sessionIds: new Set(["s-q", "s-r", "s-form", "s-other"]),
    ...overrides,
  };
}

function packet(bridges: PacketBridge[] = [bridge()]): ThinkerPacket {
  return { now: "2026-10-25T18:00:00.000Z", timezone: "UTC", trigger: "manual", rebuild: false, lastRunAt: null, bridges, memory: [], feedback: [], previousItems: [], outsideSources: [] };
}

function memory(overrides: Partial<HelmMemoryEntry>): HelmMemoryEntry {
  return {
    id: "m1", kind: "rule", key: null, text: "A rule", source: null, author: "helm", status: "active",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", confirmedAt: "2026-10-01T00:00:00.000Z", uses: 0, fromSources: [], ...overrides,
  };
}

describe("thinker publication", () => {
  it("accepts a brief whose actions point at what the run was shown", () => {
    const result = validatePublication({
      summary: "Quiet day.",
      items: [{
        kind: "question", bridge: "local", title: "Install the bot login?", recommendation: "Yes.",
        evidence: [{ label: "The question", sessionId: "s-q" }],
        actions: [{ label: "Yes", primary: true, type: "answer", sessionId: "s-q", requestId: "r1", answer: "yes" }, { label: "Open", type: "open", sessionId: "s-q" }],
        replyTo: { sessionId: "s-q" },
      }],
      proposals: [
        { bridge: "local", text: "Close LA trip", actions: [{ label: "Close", type: "close_tasks", taskIds: ["t2"] }] },
        { bridge: "local", text: "AWC's instructions hold old stories", actions: [{ label: "Tidy", type: "tidy_task", taskId: "t1" }] },
      ],
      handled: [{ bridge: "local", sessionId: "s-r", why: "FYI: fixed" }],
      memory: { threads: [{ bridge: "local", taskId: "t1", text: "Return flight pending" }], picture: "Tim is planning AWC." },
    }, packet(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The answer is matched to the question's own choice, word for word.
    expect(result.brief.items[0]!.actions[0]!.do).toEqual({ type: "answer", bridge: "local", sessionId: "s-q", requestId: "r1", answer: "Yes", wasFreeform: false });
    // A question without free text can't be answered in Tim's own words.
    expect(result.brief.items[0]!.reply).toEqual({ bridge: "local", sessionId: "s-q" });
    expect(result.handled).toEqual([{ bridge: "local", sessionId: "s-r", title: "Flyer", why: "FYI: fixed", activityAt: "2026-10-25T10:00:00.000Z" }]);
    expect(result.brief.proposals[1]!.actions[0]!.do).toEqual({ type: "tidy_task", bridge: "local", taskId: "t1" });
    expect(result.memory).toContainEqual({ op: "upsert", kind: "thread", key: "local:t1", text: "Return flight pending", source: "AWC" });
  });

  it("refuses actions that point at anything the run was not shown, or answers outside the choices", () => {
    const result = validatePublication({
      summary: "x",
      items: [{
        kind: "decision", bridge: "local", title: "t", recommendation: "r",
        actions: [
          { label: "a", type: "answer", sessionId: "s-q", requestId: "r1", answer: "Maybe" },
          { label: "b", type: "send", sessionId: "made-up", message: "hello" },
          { label: "c", type: "tick", actionId: "nope" },
        ],
      }, {
        kind: "question", bridge: "local", title: "form", recommendation: "r",
        actions: [{ label: "d", type: "answer", sessionId: "s-form", requestId: "r2", answer: "x" }],
      }],
    }, packet(), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/must be one of: Yes \| No/);
    expect(result.errors.join("\n")).toMatch(/send needs the sessionId/);
    expect(result.errors.join("\n")).toMatch(/tick needs the actionId/);
    expect(result.errors.join("\n")).toMatch(/can't be answered from Home/);
  });

  it("never marks read a conversation that is waiting on a question, and only listed replies", () => {
    const result = validatePublication({
      summary: "x", items: [],
      handled: [{ bridge: "local", sessionId: "s-q", why: "x" }, { bridge: "local", sessionId: "s-other", why: "x" }],
    }, packet(), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "handled 1: that conversation is waiting on a question; it can't be marked read",
      "handled 2: only an unread reply listed for local can be marked read",
    ]);
  });

  it("refuses peer task closing and tidying, tidying without signs, and bridges that are unavailable", () => {
    const peer = bridge({ id: "pc", label: "PC" });
    const down: PacketBridge = { ...bridge({ id: "work" }), ok: false, error: "down" };
    const result = validatePublication({
      summary: "x",
      items: [{ kind: "fyi", bridge: "work", title: "t", recommendation: "r" }],
      proposals: [
        { bridge: "pc", text: "close", actions: [{ label: "Close", type: "close_tasks", taskIds: ["t1"] }, { label: "Tidy", type: "tidy_task", taskId: "t1" }] },
        { bridge: "local", text: "tidy", actions: [{ label: "Tidy", type: "tidy_task", taskId: "t2" }] },
      ],
    }, packet([bridge(), peer, down]), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/item 1: bridge must be one of local, pc/);
    expect(result.errors.join("\n")).toMatch(/close_tasks only works for tasks on bridge "local"/);
    expect(result.errors.join("\n")).toMatch(/proposal 1 action 2: tidy_task only works for tasks on bridge "local"/);
    expect(result.errors.join("\n")).toMatch(/proposal 2 action 1: tidy_task needs the taskId of a local task listed with tidy signs/);
  });

  it("protects Tim's memory and enforces the size limits", () => {
    const mine = memory({ id: "u1", author: "user", text: "Ministry first on weekends", kind: "priority" });
    const theirs = memory({ id: "h1", kind: "person", key: "bryce", text: "Buyer" });
    const userThread = memory({ id: "u2", kind: "thread", key: "local:t1", author: "user", text: "Mine" });
    const result = validatePublication({
      summary: "x", items: [],
      memory: {
        drop: ["u1", "h1"],
        threads: [{ bridge: "local", taskId: "t1", text: "Overwrite attempt" }],
        proposeRules: [{ text: "A rule" }, { text: "New rule" }],
      },
    }, packet(), [mine, theirs, userThread, memory({ id: "r0", text: "A rule" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([`memory.drop: "Ministry first on weekends" is Tim's; only he can change it`]);

    const ok = validatePublication({
      summary: "x", items: [],
      memory: { drop: ["h1"], threads: [{ bridge: "local", taskId: "t1", text: "Overwrite attempt" }], proposeRules: [{ text: "a  RULE" }, { text: "New rule" }] },
    }, packet(), [mine, theirs, userThread, memory({ id: "r0", text: "A rule" })]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    // Tim's thread is left alone, and a rule that already exists is not proposed again.
    expect(ok.memory).toEqual([{ op: "drop", id: "h1" }, { op: "propose", kind: "rule", text: "New rule", source: null }]);

    const many = Array.from({ length: 121 }, (_, index) => ({ bridge: "local", taskId: "t1", text: `x${index}` }));
    const tasks = Array.from({ length: 121 }, (_, index) => ({ taskId: `t${index}`, title: `T${index}`, changed: true }));
    const big = validatePublication({ summary: "x", items: [], memory: { threads: many.map((thread, index) => ({ ...thread, taskId: `t${index}` })) } }, packet([bridge({ tasks })]), []);
    expect(big.ok).toBe(false);
    if (big.ok) return;
    expect(big.errors.at(-1)).toMatch(/121 thread entries; the limit is 120/);
  });

  it("caps the number of items and long pictures", () => {
    const items = Array.from({ length: 7 }, () => ({ kind: "fyi", bridge: "local", title: "t", recommendation: "r" }));
    const result = validatePublication({ summary: "x", items, memory: { picture: "word ".repeat(4001) } }, packet(), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("items must be a list of at most 6");
    expect(result.errors.join("\n")).toMatch(/4001 words/);
  });
});

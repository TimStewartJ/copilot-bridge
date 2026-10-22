import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatMessage } from "../../api";
import type { LivePendingUserMessage } from "../../useSessionStream";
import {
  indexUserMessageHistory,
  learnFromLive,
  mergeUserMessages,
  settlePendingSends,
  type PendingSend,
  type UserMessageEntry,
} from "./user-message-merge";

interface World {
  history: ChatEntry[];
  live: LivePendingUserMessage[];
  sends: PendingSend[];
}

type Step = [what: string, change: (world: World) => World, expected: string[]];

const EMPTY: World = { history: [], live: [], sends: [] };
const SENDING = { failed: false } as const;
const QUEUED = { failed: false, queued: true } as const;
const FAILED = { failed: true, error: "network unavailable" } as const;
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

function deliveryLabel(entry: UserMessageEntry): string {
  if (!entry.delivery) return "sent";
  if (entry.delivery.failed) return "failed";
  return entry.delivery.queued ? "queued" : "sending";
}

/** What the transcript shows for user messages: history, then the live overlay's user bubbles. */
function view(world: World): string[] {
  const merge = mergeUserMessages({
    history: indexUserMessageHistory(world.history),
    live: world.live,
    placeholders: world.sends,
  });
  const saved = world.history.flatMap((entry) => (
    (!entry.type || entry.type === "message") && entry.role === "user" ? [`history ${entry.content}`] : []
  ));
  return [
    ...saved,
    ...merge.liveEntries.map((entry) => `live ${entry.content} (${deliveryLabel(entry)})`),
    ...merge.placeholderEntries.map((entry) => `placeholder ${entry.content} (${deliveryLabel(entry)})`),
  ];
}

/** Applies a change, then what ChatView's settle effect does after the render. */
function step(world: World, change: (world: World) => World): World {
  const next = change(world);
  return {
    ...next,
    sends: settlePendingSends(next.sends, next.live, indexUserMessageHistory(next.history)),
  };
}

function send(id: string, content: string, delivery?: PendingSend["delivery"]): (world: World) => World {
  return (world) => ({ ...world, sends: [...world.sends, { id, content, ...(delivery ? { delivery } : {}) }] });
}

function setDelivery(id: string, delivery: PendingSend["delivery"]): (world: World) => World {
  return (world) => ({
    ...world,
    sends: world.sends.map((entry) => (entry.id === id ? { ...entry, delivery } : entry)),
  });
}

function setLive(...live: LivePendingUserMessage[]): (world: World) => World {
  return (world) => ({ ...world, live });
}

function setHistory(...history: ChatEntry[]): (world: World) => World {
  return (world) => ({ ...world, history });
}

function savedUser(content: string, ids: Partial<ChatEntry> & { timestamp?: string }): ChatEntry {
  return { id: `saved-${content}`, role: "user", content, ...ids } as ChatEntry;
}

function savedAssistant(content: string, timestamp: string): ChatEntry {
  return { id: `saved-${content}`, role: "assistant", content, timestamp };
}

const cases: Array<{ name: string; steps: Step[] }> = [
  {
    name: "a sending placeholder renders as sending",
    steps: [["send", send("c1", "hi", SENDING), ["placeholder hi (sending)"]]],
  },
  {
    name: "an accepted placeholder renders as sent",
    steps: [["send", send("c1", "hi"), ["placeholder hi (sent)"]]],
  },
  {
    name: "a queued placeholder renders as queued",
    steps: [["send", send("c1", "hi", QUEUED), ["placeholder hi (queued)"]]],
  },
  {
    name: "a failed placeholder renders with Retry",
    steps: [["send", send("c1", "hi", FAILED), ["placeholder hi (failed)"]]],
  },
  {
    name: "the live copy arrives before the send response",
    steps: [
      ["send", send("c1", "hi", SENDING), ["placeholder hi (sending)"]],
      ["live copy", setLive({ id: "c1", content: "hi" }), ["live hi (sending)"]],
      ["accepted", setDelivery("c1", undefined), ["live hi (sent)"]],
      [
        "history",
        setHistory(savedUser("hi", { clientMessageId: "c1", sourceEventId: "e1", timestamp: T1 })),
        ["history hi"],
      ],
    ],
  },
  {
    name: "the live copy arrives after the send response",
    steps: [
      ["send", send("c1", "hi", SENDING), ["placeholder hi (sending)"]],
      ["accepted", setDelivery("c1", undefined), ["placeholder hi (sent)"]],
      ["live copy", setLive({ id: "c1", content: "hi" }), ["live hi (sent)"]],
      [
        "history",
        setHistory(savedUser("hi", { clientMessageId: "c1", sourceEventId: "e1", timestamp: T1 })),
        ["history hi"],
      ],
    ],
  },
  {
    name: "a queued send whose turn starts shows its live copy as sent",
    steps: [
      ["queued", send("c1", "hi", QUEUED), ["placeholder hi (queued)"]],
      ["turn starts", setLive({ id: "c1", content: "hi" }), ["live hi (sent)"]],
    ],
  },
  {
    name: "the live list empties before history loads, then history matches by event id",
    steps: [
      ["send", send("c1", "hi"), ["placeholder hi (sent)"]],
      ["committed", setLive({ id: "c1", content: "hi", sourceEventId: "e1", timestamp: T1 }), ["live hi (sent)"]],
      ["next send empties the list", setLive(), ["placeholder hi (sent)"]],
      ["history without clientMessageId", setHistory(savedUser("hi", { sourceEventId: "e1", timestamp: T1 })), [
        "history hi",
      ]],
      ["the list empties again", setLive(), ["history hi"]],
    ],
  },
  {
    name: "the live list empties before history loads, then history matches by message id",
    steps: [
      ["send", send("c1", "hi"), ["placeholder hi (sent)"]],
      ["live copy", setLive({ id: "c1", content: "hi", messageId: "m1" }), ["live hi (sent)"]],
      ["next send empties the list", setLive(), ["placeholder hi (sent)"]],
      ["history", setHistory(savedUser("hi", { messageId: "m1", timestamp: T1 })), ["history hi"]],
    ],
  },
  {
    name: "the live list empties before history loads, then the saved message is above the loaded window",
    steps: [
      ["send", send("c1", "hi"), ["placeholder hi (sent)"]],
      ["committed", setLive({ id: "c1", content: "hi", sourceEventId: "e1", timestamp: T1 }), ["live hi (sent)"]],
      ["next send empties the list", setLive(), ["placeholder hi (sent)"]],
      ["history window starts after it", setHistory(savedAssistant("reply", T2)), []],
    ],
  },
  {
    name: "history with clientMessageId arrives while the send is still in flight",
    steps: [
      ["send", send("c1", "hi", SENDING), ["placeholder hi (sending)"]],
      ["live copy", setLive({ id: "c1", content: "hi" }), ["live hi (sending)"]],
      ["history", setHistory(savedUser("hi", { clientMessageId: "c1" })), ["history hi"]],
      ["accepted after it settled", setDelivery("c1", undefined), ["history hi"]],
    ],
  },
  {
    name: "history with clientMessageId arrives before any live copy",
    steps: [
      ["send", send("c1", "hi", SENDING), ["placeholder hi (sending)"]],
      ["history", setHistory(savedUser("hi", { clientMessageId: "c1" })), ["history hi"]],
    ],
  },
  {
    name: "history without clientMessageId matches the live copy's message id",
    steps: [
      ["send", send("c1", "hi"), ["placeholder hi (sent)"]],
      ["live copy", setLive({ id: "c1", content: "hi", messageId: "m1" }), ["live hi (sent)"]],
      ["history", setHistory(savedUser("hi", { messageId: "m1" })), ["history hi"]],
    ],
  },
  {
    name: "history without clientMessageId matches the live copy's event id",
    steps: [
      ["send", send("c1", "hi"), ["placeholder hi (sent)"]],
      ["live copy", setLive({ id: "c1", content: "hi", sourceEventId: "e1" }), ["live hi (sent)"]],
      ["history", setHistory(savedUser("hi", { sourceEventId: "e1" })), ["history hi"]],
    ],
  },
  {
    name: "history without ids covers the live copy by its watermark",
    steps: [
      ["send", send("c1", "hi"), ["placeholder hi (sent)"]],
      ["live copy", setLive({ id: "c1", content: "hi", timestamp: T1 }), ["live hi (sent)"]],
      ["history", setHistory(savedUser("hi", { timestamp: T1 })), ["history hi"]],
    ],
  },
  {
    name: "a live copy newer than the watermark still renders",
    steps: [
      ["history", setHistory(savedAssistant("older", T1)), []],
      ["live copy", setLive({ id: "c1", content: "hi", timestamp: T2 }), ["live hi (sent)"]],
    ],
  },
  {
    name: "two sends with identical text resolve independently",
    steps: [
      ["first send", send("c1", "same"), ["placeholder same (sent)"]],
      ["second send", send("c2", "same", SENDING), ["placeholder same (sent)", "placeholder same (sending)"]],
      [
        "first live copy",
        setLive({ id: "c1", content: "same", sourceEventId: "e1", timestamp: T1 }),
        ["live same (sent)", "placeholder same (sending)"],
      ],
      [
        "first saved",
        setHistory(savedUser("same", { clientMessageId: "c1", sourceEventId: "e1", timestamp: T1 })),
        ["history same", "placeholder same (sending)"],
      ],
      [
        "second live copy",
        setLive({ id: "c2", content: "same", timestamp: T3 }),
        ["history same", "live same (sending)"],
      ],
      [
        "second saved",
        setHistory(
          savedUser("same", { clientMessageId: "c1", sourceEventId: "e1", timestamp: T1 }),
          { ...savedUser("same", { clientMessageId: "c2", sourceEventId: "e2", timestamp: T3 }), id: "saved-2" },
        ),
        ["history same", "history same"],
      ],
    ],
  },
  {
    name: "another device's live copy renders until history names it by event id",
    steps: [
      ["live copy", setLive({ id: "server-1", content: "remote", sourceEventId: "e1" }), ["live remote (sent)"]],
      ["history", setHistory(savedUser("remote", { sourceEventId: "e1" })), ["history remote"]],
    ],
  },
  {
    name: "another device's live copy is hidden by a saved clientMessageId",
    steps: [
      ["live copy", setLive({ id: "client-other", content: "remote" }), ["live remote (sent)"]],
      ["history", setHistory(savedUser("remote", { clientMessageId: "client-other" })), ["history remote"]],
    ],
  },
  {
    name: "another device's live copy is hidden by the watermark",
    steps: [
      ["live copy", setLive({ id: "server-1", content: "remote", timestamp: T1 }), ["live remote (sent)"]],
      ["history window starts after it", setHistory(savedAssistant("reply", T2)), []],
    ],
  },
  {
    name: "a failed send keeps its Retry over its live copy and history matched without its id",
    steps: [
      ["failed", send("c1", "hi", FAILED), ["placeholder hi (failed)"]],
      ["live copy", setLive({ id: "c1", content: "hi", sourceEventId: "e1", timestamp: T1 }), [
        "placeholder hi (failed)",
      ]],
      ["the list empties", setLive(), ["placeholder hi (failed)"]],
      ["history window starts after it", setHistory(savedAssistant("reply", T2)), ["placeholder hi (failed)"]],
    ],
  },
  {
    name: "a failed send history already holds by clientMessageId is settled",
    steps: [
      ["failed", send("c1", "hi", FAILED), ["placeholder hi (failed)"]],
      ["history", setHistory(savedUser("hi", { clientMessageId: "c1" })), ["history hi"]],
    ],
  },
];

describe("mergeUserMessages", () => {
  it.each(cases)("$name", ({ steps }) => {
    let world = EMPTY;
    for (const [what, change, expected] of steps) {
      world = step(world, change);
      expect(view(world), what).toEqual(expected);
    }
  });

  it("drops settled sends and keeps the others", () => {
    const merge = mergeUserMessages({
      history: indexUserMessageHistory([savedUser("hi", { clientMessageId: "c1" })]),
      live: [],
      placeholders: [{ id: "c1", content: "hi" }, { id: "c2", content: "next", delivery: SENDING }],
    });
    expect([...merge.settledIds]).toEqual(["c1"]);
    expect(merge.placeholderEntries.map((entry) => entry.id)).toEqual(["c2"]);
  });

  it("keeps entry ids and fields the transcript renders", () => {
    const attachments = [{ type: "file" as const, path: "notes.md" }];
    const merge = mergeUserMessages({
      history: indexUserMessageHistory([]),
      live: [{ id: "c1", content: "hi", attachments, timestamp: T1 }],
      placeholders: [
        { id: "c1", content: "hi", delivery: SENDING },
        { id: "c2", content: "next", attachments, delivery: FAILED },
      ],
    });
    expect(merge.liveEntries).toEqual([{
      id: "live-user-c1",
      type: "message",
      role: "user",
      content: "hi",
      delivery: SENDING,
      attachments,
      timestamp: T1,
    }]);
    expect(merge.placeholderEntries).toEqual([{
      id: "c2",
      type: "message",
      role: "user",
      content: "next",
      delivery: FAILED,
      attachments,
    }]);
  });
});

describe("learnFromLive", () => {
  it("returns the same array when there is nothing to learn", () => {
    const sends: PendingSend[] = [{ id: "c1", content: "hi", sourceEventId: "e1", timestamp: T1 }];
    expect(learnFromLive(sends, [])).toBe(sends);
    expect(learnFromLive(sends, [{ id: "other", content: "x", sourceEventId: "e9" }])).toBe(sends);
    expect(learnFromLive(sends, [{ id: "c1", content: "hi", sourceEventId: "e1", timestamp: T1 }])).toBe(sends);
  });

  it("only adds what the send does not know yet", () => {
    const sends: PendingSend[] = [{ id: "c1", content: "hi", sourceEventId: "e1" }];
    const learned = learnFromLive(sends, [{
      id: "c1",
      content: "hi",
      messageId: "m1",
      sourceEventId: "e2",
      timestamp: T1,
    }]);
    expect(learned).toEqual([{ id: "c1", content: "hi", messageId: "m1", sourceEventId: "e1", timestamp: T1 }]);
  });
});

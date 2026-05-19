import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedStore, FeedCardValidationError, type FeedCardPageFilters, type FeedStore } from "../feed-store.js";
import { createTaskStore } from "../task-store.js";
import type { DatabaseSync } from "../db.js";
import { createTestBus, setupTestDb } from "./helpers.js";

function makeVisual(cardId: string, artifactId: string) {
  return {
    artifactId,
    kind: "mermaid" as const,
    title: "Flow",
    displayName: "flow.mmd",
    mimeType: "text/vnd.mermaid",
    size: 16,
    url: `/api/feed/${cardId}/visuals/${artifactId}`,
    downloadUrl: `/api/feed/${cardId}/visuals/${artifactId}/download`,
  };
}

let db: DatabaseSync;
let store: FeedStore;

beforeEach(() => {
  db = setupTestDb();
  const bus = createTestBus();
  store = createFeedStore(db, bus);
});

function listPageCards(filters: FeedCardPageFilters = {}) {
  return store.listCardPage(filters).cards;
}

function listPageIds(filters: FeedCardPageFilters = {}) {
  return listPageCards(filters).map((card) => card.id);
}

describe("feed-store", () => {
  it("inserts separate keyless cards", () => {
    const first = store.saveCard({ title: "First" });
    const second = store.saveCard({ title: "First" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.card.id).not.toBe(second.card.id);
    expect(listPageCards()).toHaveLength(2);
  });

  it("upserts keyed cards and preserves status unless explicitly changed", () => {
    const created = store.saveCard({
      key: "preview:abc",
      title: "Preview building",
      body: "Waiting on validation",
      status: "active",
    });
    const dismissed = store.updateCardById(created.card.id, { status: "dismissed" });

    const updated = store.saveCard({
      key: "preview:abc",
      title: "Preview ready",
      body: "Open the preview",
    });

    expect(updated.created).toBe(false);
    expect(updated.card.id).toBe(created.card.id);
    expect(updated.card.title).toBe("Preview ready");
    expect(updated.card.body).toBe("Open the preview");
    expect(updated.card.status).toBe("dismissed");
    expect(updated.card.statusChangedAt).toBe(dismissed.statusChangedAt);

    const reactivated = store.saveCard({
      key: "preview:abc",
      title: "Preview ready",
      status: "active",
    });
    expect(reactivated.card.status).toBe("active");
  });

  it("updates only provided fields", () => {
    const { card } = store.saveCard({
      title: "Decision",
      body: "Pick one",
      kind: "decision",
      priority: "high",
      pinned: true,
      links: [{ label: "Spec", url: "https://example.test/spec" }],
      metadata: { source: "agent" },
    });

    const updated = store.updateCardById(card.id, { body: "Pick option B" });

    expect(updated).toMatchObject({
      title: "Decision",
      body: "Pick option B",
      kind: "decision",
      priority: "high",
      pinned: true,
      metadata: { source: "agent" },
    });
    expect(updated.links).toEqual([{ label: "Spec", url: "https://example.test/spec" }]);
  });

  it("keeps default pages active-only and orders resolved filters by status change time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
      const oldDone = store.saveCard({ key: "old-done", title: "Old done" }).card;
      vi.setSystemTime(new Date("2026-05-13T10:00:01.000Z"));
      const active = store.saveCard({ key: "active", title: "Active" }).card;
      vi.setSystemTime(new Date("2026-05-13T10:00:02.000Z"));
      const newDone = store.saveCard({ key: "new-done", title: "New done" }).card;

      vi.setSystemTime(new Date("2026-05-13T10:00:03.000Z"));
      store.updateCardById(oldDone.id, { status: "done" });
      vi.setSystemTime(new Date("2026-05-13T10:00:04.000Z"));
      store.updateCardById(active.id, { title: "Still active" });
      vi.setSystemTime(new Date("2026-05-13T10:00:05.000Z"));
      store.updateCardById(newDone.id, { status: "done" });

      expect(listPageIds({ limit: 10 })).toEqual([active.id]);
      expect(listPageIds({ status: "done", limit: 10 })).toEqual([
        newDone.id,
        oldDone.id,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates active cards with an opaque cursor across pinned and unpinned cards", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
      const oldPinned = store.saveCard({ title: "Old pinned", pinned: true }).card;
      vi.setSystemTime(new Date("2026-05-13T10:01:00.000Z"));
      const unpinned = store.saveCard({ title: "Unpinned" }).card;
      vi.setSystemTime(new Date("2026-05-13T10:02:00.000Z"));
      const newPinned = store.saveCard({ title: "New pinned", pinned: true }).card;

      const firstPage = store.listCardPage({ limit: 2 });
      expect(firstPage.cards.map((card) => card.id)).toEqual([newPinned.id, oldPinned.id]);
      expect(firstPage.nextCursor).toEqual(expect.any(String));

      const secondPage = store.listCardPage({ limit: 2, cursor: firstPage.nextCursor! });
      expect(secondPage.cards.map((card) => card.id)).toEqual([unpinned.id]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates resolved cards by updated time across equal status changes", () => {
    vi.useFakeTimers();
    try {
      const statusChangedAt = "2026-05-13T10:00:00.000Z";
      vi.setSystemTime(new Date(statusChangedAt));
      const oldestUpdated = store.saveCard(
        { title: "Oldest updated", status: "done" },
        { createId: "00000000-0000-4000-8000-000000000001" },
      ).card;
      const sameUpdatedHighId = store.saveCard(
        { title: "Same updated high id", status: "done" },
        { createId: "00000000-0000-4000-8000-000000000004" },
      ).card;
      const sameUpdatedLowId = store.saveCard(
        { title: "Same updated low id", status: "done" },
        { createId: "00000000-0000-4000-8000-000000000003" },
      ).card;
      const newestUpdated = store.saveCard(
        { title: "Newest updated", status: "done" },
        { createId: "00000000-0000-4000-8000-000000000002" },
      ).card;

      vi.setSystemTime(new Date("2026-05-13T10:01:00.000Z"));
      store.updateCardById(oldestUpdated.id, { body: "Updated first" });
      vi.setSystemTime(new Date("2026-05-13T10:02:00.000Z"));
      store.updateCardById(sameUpdatedHighId.id, { body: "Updated second" });
      store.updateCardById(sameUpdatedLowId.id, { body: "Updated third" });
      vi.setSystemTime(new Date("2026-05-13T10:03:00.000Z"));
      store.updateCardById(newestUpdated.id, { body: "Updated fourth" });

      const seededCards = [oldestUpdated, sameUpdatedHighId, sameUpdatedLowId, newestUpdated]
        .map((card) => store.getCard(card.id)!);
      expect(new Set(seededCards.map((card) => card.statusChangedAt))).toEqual(new Set([statusChangedAt]));

      const firstPage = store.listCardPage({ status: "done", limit: 2 });
      expect(firstPage.cards.map((card) => card.id)).toEqual([newestUpdated.id, sameUpdatedHighId.id]);
      expect(firstPage.nextCursor).toEqual(expect.any(String));

      const secondPage = store.listCardPage({ status: "done", limit: 2, cursor: firstPage.nextCursor! });
      expect(secondPage.cards.map((card) => card.id)).toEqual([sameUpdatedLowId.id, oldestUpdated.id]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects cursors reused with different feed filters", () => {
    store.saveCard({ title: "First" });
    store.saveCard({ title: "Second" });

    const firstPage = store.listCardPage({ limit: 1 });

    expect(() => store.listCardPage({ status: "done", limit: 1, cursor: firstPage.nextCursor! }))
      .toThrow("cursor does not match feed filters");
  });

  it("rejects key fields on direct updates without changing the card", () => {
    const created = store.saveCard({ key: "stable:key", title: "Stable" }).card;
    const before = store.getCard(created.id);

    for (const { input, field, update } of [
      {
        input: { key: "renamed:key", title: "Renamed" },
        field: "key",
        update: () => store.updateCardById(created.id, { key: "renamed:key", title: "Renamed" }),
      },
      {
        input: { dedupeKey: null, title: "Renamed" },
        field: "dedupeKey",
        update: () => store.updateCardById(created.id, { dedupeKey: null, title: "Renamed" }),
      },
      {
        input: { key: "stable:key", title: "Renamed" },
        field: "key",
        update: () => store.updateCardByKey("stable:key", { key: "stable:key", title: "Renamed" }),
      },
    ]) {
      expect(update, JSON.stringify(input)).toThrow(`Feed card key fields cannot be updated (${field})`);
      expect(store.getCard(created.id)).toEqual(before);
    }
  });

  it("stores, preserves, replaces, and clears prompt actions", () => {
    const created = store.saveCard({
      key: "action:one",
      title: "Action card",
      action: {
        label: "Review now",
        prompt: "Review this staged change.",
        taskId: "task-action",
      },
    }).card;

    expect(created.action).toEqual({
      label: "Review now",
      prompt: "Review this staged change.",
      taskId: "task-action",
    });

    const preserved = store.saveCard({
      key: "action:one",
      title: "Action card renamed",
    }).card;
    expect(preserved.action).toEqual(created.action);

    const replaced = store.updateCardById(created.id, {
      action: {
        prompt: "Use this replacement prompt.",
        taskId: null,
      },
    });
    expect(replaced.action).toEqual({
      prompt: "Use this replacement prompt.",
      taskId: null,
    });

    const cleared = store.updateCardById(created.id, { action: null });
    expect(cleared.action).toBeNull();
  });

  it("preserves omitted action taskId separately from explicit standalone null", () => {
    const bus = createTestBus();
    const taskStore = createTaskStore(db, bus);
    store = createFeedStore(db, bus);
    const task = taskStore.createTask("Card task");

    const omitted = store.saveCard({
      title: "Inherit task",
      taskId: task.id,
      action: { prompt: "Continue with card task." },
    }).card;
    const standalone = store.saveCard({
      title: "Standalone",
      taskId: task.id,
      action: { prompt: "Start standalone.", taskId: null },
    }).card;

    expect(omitted.action).toEqual({ prompt: "Continue with card task." });
    expect(Object.prototype.hasOwnProperty.call(omitted.action!, "taskId")).toBe(false);
    expect(standalone.action).toEqual({ prompt: "Start standalone.", taskId: null });
  });

  it("sorts active pages by pinned state and then by creation time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
      const oldPinned = store.saveCard({ title: "Old pinned", pinned: true }).card;
      vi.setSystemTime(new Date("2026-05-13T10:01:00.000Z"));
      const unpinned = store.saveCard({ title: "Unpinned" }).card;
      vi.setSystemTime(new Date("2026-05-13T10:02:00.000Z"));
      const newPinned = store.saveCard({ title: "New pinned", pinned: true }).card;
      vi.setSystemTime(new Date("2026-05-13T10:03:00.000Z"));
      store.updateCardById(oldPinned.id, { title: "Old pinned updated" });

      expect(listPageIds()).toEqual([
        newPinned.id,
        oldPinned.id,
        unpinned.id,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps active cards above resolved cards when listing all statuses", () => {
    const resolvedPinned = store.saveCard({ title: "Resolved pinned", status: "done", pinned: true }).card;
    const active = store.saveCard({ title: "Active", pinned: false }).card;

    expect(listPageIds({ includeDismissed: true })).toEqual([
      active.id,
      resolvedPinned.id,
    ]);
  });

  it("does not issue cursors for mixed-status pages", () => {
    store.saveCard({ title: "Active" });
    store.saveCard({ title: "Done", status: "done" });

    const page = store.listCardPage({ includeDismissed: true, limit: 1 });

    expect(page.cards).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("filters cards", () => {
    const bus = createTestBus();
    const taskStore = createTaskStore(db, bus);
    store = createFeedStore(db, bus);
    const task = taskStore.createTask("Feed task");
    const taskCard = store.saveCard({ title: "Task card", taskId: task.id, kind: "todo" }).card;
    store.saveCard({ title: "Session card", sessionId: "session-1", kind: "note" });
    store.saveCard({ title: "Done card", status: "done", kind: "todo" });

    expect(listPageIds({ taskId: task.id })).toEqual([taskCard.id]);
    expect(listPageCards({ sessionId: "session-1" })).toHaveLength(1);
    expect(listPageIds({ kind: "todo" })).toEqual([taskCard.id]);
    expect(listPageCards({ status: "done" })).toHaveLength(1);
    expect(listPageCards()).toHaveLength(2);
    expect(listPageCards({ includeDismissed: true })).toHaveLength(3);
  });

  it("deletes cards by id and key", () => {
    const keyed = store.saveCard({ key: "delete-me", title: "Keyed" }).card;
    const keyless = store.saveCard({ title: "Keyless" }).card;

    expect(store.deleteCardByKey("delete-me")).toBe(true);
    expect(store.getCard(keyed.id)).toBeUndefined();
    expect(store.deleteCardById(keyless.id)).toBe(true);
    expect(store.getCard(keyless.id)).toBeUndefined();
    expect(store.deleteCardById("missing")).toBe(false);
  });

  it("stores feed-owned visuals and reports unreferenced visuals on replace, clear, and delete", () => {
    const bus = createTestBus();
    const removed: string[] = [];
    store = createFeedStore(db, bus, {
      onVisualUnreferenced: (visual) => removed.push(visual.artifactId),
    });
    const cardId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const firstVisual = makeVisual(cardId, "11111111-1111-4111-8111-111111111111");
    const secondVisual = makeVisual(cardId, "22222222-2222-4222-8222-222222222222");

    const created = store.saveCard({ title: "Visual card" }, { createId: cardId, visual: firstVisual }).card;
    expect(created.visual).toEqual(firstVisual);

    const renamed = store.updateCardById(cardId, { title: "Still visual" });
    expect(renamed.visual?.artifactId).toBe(firstVisual.artifactId);
    expect(removed).toEqual([]);

    const replaced = store.updateCardById(cardId, {}, { visual: secondVisual });
    expect(replaced.visual).toEqual(secondVisual);
    expect(removed).toEqual([firstVisual.artifactId]);

    const cleared = store.updateCardById(cardId, {}, { visual: null });
    expect(cleared.visual).toBeNull();
    expect(removed).toEqual([firstVisual.artifactId, secondVisual.artifactId]);

    store.updateCardById(cardId, {}, { visual: firstVisual });
    expect(store.deleteCardById(cardId)).toBe(true);
    expect(removed).toEqual([firstVisual.artifactId, secondVisual.artifactId, firstVisual.artifactId]);
  });

  it("sets taskId to null when a linked task is deleted", () => {
    const bus = createTestBus();
    const taskStore = createTaskStore(db, bus);
    store = createFeedStore(db, bus);
    const task = taskStore.createTask("Feed task");
    const { card } = store.saveCard({ title: "Task card", taskId: task.id });

    taskStore.deleteTask(task.id);

    expect(store.getCard(card.id)?.taskId).toBeNull();
  });

  it("emits feed change events", () => {
    const bus = createTestBus();
    const events: unknown[] = [];
    bus.subscribe((event) => events.push(event));
    store = createFeedStore(db, bus);

    const { card } = store.saveCard({ key: "event-key", title: "Event card", sessionId: "session-1" });
    store.updateCardById(card.id, { status: "done" });
    store.deleteCardByKey("event-key");

    expect(events).toEqual([
      expect.objectContaining({ type: "feed:changed", cardId: card.id, dedupeKey: "event-key", sessionId: "session-1" }),
      expect.objectContaining({ type: "feed:changed", cardId: card.id, dedupeKey: "event-key", sessionId: "session-1" }),
      expect.objectContaining({ type: "feed:changed", cardId: card.id, dedupeKey: "event-key", sessionId: "session-1" }),
    ]);
  });

  it("rejects invalid and oversized input", () => {
    expect(() => store.saveCard({ title: "" })).toThrow(FeedCardValidationError);
    expect(() => store.saveCard({ title: "Bad", status: "paused" })).toThrow("status must be one of");
    expect(() => store.saveCard({ title: "Bad", priority: "urgent" })).toThrow("priority must be one of");
    expect(() => store.saveCard({ title: "Bad", links: [{ label: "No URL" }] })).toThrow("url is required");
    expect(() => store.saveCard({ title: "Bad", url: "javascript:alert(1)" })).toThrow("url must be http");
    expect(() => store.saveCard({ title: "Bad", links: [{ label: "Bad", url: "data:text/html,hi" }] })).toThrow("links[0].url must be http");
    expect(() => store.saveCard({ title: "Bad", metadata: [] })).toThrow("metadata must be an object");
    expect(() => store.saveCard({ title: "Bad", action: {} })).toThrow("action.prompt is required");
    expect(() => store.saveCard({ title: "Bad", action: { prompt: "Ok", label: "Bad\nlabel" } })).toThrow("action.label cannot contain control characters");
    expect(() => store.saveCard({ title: "Bad", action: { prompt: "Ok", extra: true } })).toThrow("Unknown action field");
    expect(() => store.saveCard({ title: "Bad", body: "x".repeat(9 * 1024) })).toThrow("body must be");
    expect(() => store.saveCard({ title: "Bad", pinnned: true } as any)).toThrow("Unknown feed card field");
  });

  it("rejects duplicate keys at the database boundary", () => {
    store.saveCard({ key: "same", title: "Same" });

    expect(() => db.prepare(`
      INSERT INTO feed_cards (
        id, dedupeKey, title, kind, priority, status, linksJson, pinned,
        statusChangedAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "manual-duplicate",
      "same",
      "Duplicate",
      "note",
      "normal",
      "active",
      "[]",
      0,
      "2026-05-13T10:00:00.000Z",
      "2026-05-13T10:00:00.000Z",
      "2026-05-13T10:00:00.000Z",
    )).toThrow();
  });
});

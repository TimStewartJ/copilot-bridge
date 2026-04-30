import { describe, expect, it } from "vitest";
import type { ChatToolEntry, ToolCall } from "../api";
import { buildRenderableSegmentRoots, buildToolCallForest } from "./tool-call-tree";
import { computeToolCallTracks, type ToolCallTrackLayout } from "./tool-call-tracks";

const BASE_MS = Date.parse("2026-04-23T20:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

function createToolCall(toolCallId: string, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId,
    name: partial.name ?? toolCallId,
    ...partial,
  };
}

function completedToolCall(
  toolCallId: string,
  startSeconds: number,
  endSeconds: number,
  partial: Partial<ToolCall> = {},
): ToolCall {
  return createToolCall(toolCallId, {
    startedAt: at(startSeconds),
    completedAt: at(endSeconds),
    success: true,
    ...partial,
  });
}

function rootNodes(toolCalls: ToolCall[]) {
  return buildToolCallForest(toolCalls).roots;
}

function laneIds(layout: ToolCallTrackLayout): string[][] {
  return layout.lanes.map((lane) => lane.items.map((item) => item.node.toolCall.toolCallId));
}

function toolEntry(toolCall: ToolCall): ChatToolEntry {
  return {
    id: toolCall.toolCallId,
    type: "tool",
    toolCall,
  };
}

describe("tool call track helpers", () => {
  it("shares one lane for five sequential roots without overlap", () => {
    const layout = computeToolCallTracks(rootNodes([
      completedToolCall("first", 0, 4),
      completedToolCall("second", 5, 9),
      completedToolCall("third", 10, 12),
      completedToolCall("fourth", 13, 15),
      completedToolCall("fifth", 16, 18),
    ]));

    expect(layout.trackCount).toBe(1);
    expect(layout.maxConcurrency).toBe(1);
    expect(layout.hasOverlap).toBe(false);
    expect(laneIds(layout)).toEqual([["first", "second", "third", "fourth", "fifth"]]);
  });

  it("uses two lanes for two-way overlaps", () => {
    const layout = computeToolCallTracks(rootNodes([
      completedToolCall("long", 0, 10),
      completedToolCall("overlap", 5, 15),
      completedToolCall("later", 15, 20),
    ]));

    expect(layout.trackCount).toBe(2);
    expect(layout.maxConcurrency).toBe(2);
    expect(layout.hasOverlap).toBe(true);
    expect(laneIds(layout)).toEqual([["long", "later"], ["overlap"]]);
  });

  it("uses three lanes for three-way overlaps", () => {
    const layout = computeToolCallTracks(rootNodes([
      completedToolCall("first", 0, 30),
      completedToolCall("second", 5, 20),
      completedToolCall("third", 10, 15),
    ]));

    expect(layout.trackCount).toBe(3);
    expect(layout.maxConcurrency).toBe(3);
    expect(layout.hasOverlap).toBe(true);
    expect(laneIds(layout)).toEqual([["first"], ["second"], ["third"]]);
  });

  it("uses separate lanes for siblings with equal start timestamps", () => {
    const layout = computeToolCallTracks(rootNodes([
      completedToolCall("first", 0, 10),
      completedToolCall("second", 0, 8),
      completedToolCall("third", 0, 6),
    ]));

    expect(layout.trackCount).toBe(3);
    expect(layout.maxConcurrency).toBe(3);
    expect(layout.hasOverlap).toBe(true);
    expect(laneIds(layout)).toEqual([["first"], ["second"], ["third"]]);
  });

  it("keeps an active running node from freeing its lane for later siblings", () => {
    const layout = computeToolCallTracks(rootNodes([
      createToolCall("running", { startedAt: at(0) }),
      completedToolCall("short", 5, 6),
    ]), {
      activeToolCallIds: ["running"],
      nowMs: BASE_MS + 7_000,
    });

    expect(layout.trackCount).toBe(2);
    expect(layout.maxConcurrency).toBe(2);
    expect(layout.hasOverlap).toBe(true);
    expect(laneIds(layout)).toEqual([["running"], ["short"]]);
    expect(layout.lanes[0]?.items[0]?.endMs).toBe(Number.POSITIVE_INFINITY);
    expect(layout.lanes[0]?.items[0]?.renderEndMs).toBe(BASE_MS + 7_000);
  });

  it("treats equal end and start timestamps as non-overlapping", () => {
    const layout = computeToolCallTracks(rootNodes([
      completedToolCall("first", 0, 5),
      completedToolCall("second", 5, 10),
    ]));

    expect(layout.trackCount).toBe(1);
    expect(layout.maxConcurrency).toBe(1);
    expect(layout.hasOverlap).toBe(false);
    expect(laneIds(layout)).toEqual([["first", "second"]]);
  });

  it("normalizes invalid and missing timestamps deterministically", () => {
    const layout = computeToolCallTracks(rootNodes([
      createToolCall("missing-start", { success: true }),
      createToolCall("invalid-start", { startedAt: "not-a-date", completedAt: "also-not-a-date", success: true }),
      completedToolCall("valid-start", 10, 20),
    ]));
    const normalizedStartMs = Date.parse(at(10));

    expect(layout.trackCount).toBe(1);
    expect(layout.maxConcurrency).toBe(1);
    expect(layout.hasOverlap).toBe(false);
    expect(laneIds(layout)).toEqual([["missing-start", "invalid-start", "valid-start"]]);
    expect(layout.lanes[0]?.items.map((item) => item.startMs)).toEqual([
      normalizedStartMs,
      normalizedStartMs,
      normalizedStartMs,
    ]);
    expect(layout.lanes[0]?.items[0]?.endMs).toBe(normalizedStartMs);
    expect(layout.lanes[0]?.items[1]?.endMs).toBe(normalizedStartMs);
  });

  it("does not let inactive historical snapshots without completions poison later lanes", () => {
    const layout = computeToolCallTracks(rootNodes([
      createToolCall("historical", { startedAt: at(0) }),
      completedToolCall("later", 1, 2),
    ]), {
      activeToolCallIds: [],
    });

    expect(layout.trackCount).toBe(1);
    expect(layout.maxConcurrency).toBe(1);
    expect(layout.hasOverlap).toBe(false);
    expect(laneIds(layout)).toEqual([["historical", "later"]]);
    expect(layout.lanes[0]?.items[0]?.endMs).toBe(BASE_MS);
  });

  it("uses visible descendant intervals for context-only ancestors", () => {
    const child = completedToolCall("child", 0, 5, { parentToolCallId: "parent" });
    const sibling = completedToolCall("sibling", 5, 10);
    const fullForest = buildToolCallForest([
      createToolCall("parent", { isSubAgent: true }),
      child,
      sibling,
    ]);
    const roots = buildRenderableSegmentRoots([
      toolEntry(child),
      toolEntry(sibling),
    ], fullForest);

    expect(roots[0]?.isContextOnly).toBe(true);

    const layout = computeToolCallTracks(roots);

    expect(layout.trackCount).toBe(1);
    expect(layout.maxConcurrency).toBe(1);
    expect(layout.hasOverlap).toBe(false);
    expect(laneIds(layout)).toEqual([["parent", "sibling"]]);
    expect(layout.lanes[0]?.items[0]?.startMs).toBe(Date.parse(at(0)));
    expect(layout.lanes[0]?.items[0]?.endMs).toBe(Date.parse(at(5)));
  });

  it("computes lanes for nested child tool groups", () => {
    const { roots } = buildToolCallForest([
      createToolCall("parent", { isSubAgent: true }),
      completedToolCall("child-a", 0, 10, { parentToolCallId: "parent" }),
      completedToolCall("child-b", 5, 8, { parentToolCallId: "parent" }),
      completedToolCall("child-c", 10, 12, { parentToolCallId: "parent" }),
    ]);

    const layout = computeToolCallTracks(roots[0]?.children ?? []);

    expect(layout.trackCount).toBe(2);
    expect(layout.maxConcurrency).toBe(2);
    expect(layout.hasOverlap).toBe(true);
    expect(laneIds(layout)).toEqual([["child-a", "child-c"], ["child-b"]]);
  });
});

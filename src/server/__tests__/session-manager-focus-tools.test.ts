import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createTestApp } from "./test-app.js";
import { alertDetails, decisionDetails, eventDetails } from "./focus-test-fixtures.js";
import { FeedCardValidationError } from "../feed-store.js";
import { feedCardVisualOwner, getVisualsDir } from "../visual-artifacts.js";
import * as visualPublisher from "../tools/visual-tool-publisher.js";

function getTool(ctx: AppContext, name: string) {
  const tool = getBridgeToolDefinitions(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as any;
}

function invocation(toolName: string) {
  return {
    sessionId: "focus-tool-session",
    toolCallId: `tool-${toolName}`,
    toolName,
    arguments: {},
  };
}

describe("first-class Focus tools", () => {
  it("registers Action, Decision, Alert, and Event tools alongside compatibility adapters", () => {
    const { ctx } = createTestApp();
    const names = new Set(getBridgeToolDefinitions(ctx).map((tool) => tool.name));
    for (const name of [
      "action_add",
      "action_list",
      "action_update",
      "action_remove",
      "decision_save",
      "decision_list",
      "decision_delete",
      "alert_save",
      "alert_list",
      "alert_delete",
      "event_save",
      "event_list",
      "event_delete",
      "checklist_add",
      "feed_save",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("creates rich first-class objects and keeps the legacy projection complete", async () => {
    const { ctx } = createTestApp();
    const decisionSave = getTool(ctx, "decision_save");
    const alertSave = getTool(ctx, "alert_save");
    const eventSave = getTool(ctx, "event_save");

    const decision = await decisionSave.handler({
      ...decisionDetails,
      key: "decision:tool",
      title: "Tool decision",
      launchPrompt: { label: "Discuss", prompt: "Discuss this Decision." },
      visual: { kind: "mermaid", content: "graph TD\n  A-->B" },
    }, invocation("decision_save"));
    const alert = await alertSave.handler({
      ...alertDetails(),
      key: "alert:tool",
      title: "Tool alert",
    }, invocation("alert_save"));
    const event = await eventSave.handler({
      ...eventDetails(),
      key: "release:tool",
      category: "release",
      title: "Tool event",
    }, invocation("event_save"));

    expect(decision).toMatchObject({
      success: true,
      created: true,
      decision: {
        objectType: "decision",
        launchPrompt: { label: "Discuss", prompt: "Discuss this Decision." },
        visual: { kind: "mermaid" },
      },
    });
    expect(alert.alert).toMatchObject({ objectType: "alert", priority: "high" });
    expect(event.event).toMatchObject({ objectType: "event", category: "release" });
    expect(ctx.feedStore.getCard(decision.decision.id)).toMatchObject({
      kind: "decision",
      action: { label: "Discuss", prompt: "Discuss this Decision." },
      visual: { kind: "mermaid" },
    });
  });

  it("lists and deletes objects by first-class type", async () => {
    const { ctx } = createTestApp();
    const save = getTool(ctx, "event_save");
    const list = getTool(ctx, "event_list");
    const remove = getTool(ctx, "event_delete");
    const created = await save.handler({
      ...eventDetails(),
      key: "release:list-test",
      category: "note",
      title: "Listed event",
    }, invocation("event_save"));

    const page = await list.handler({ status: "active" }, invocation("event_list"));
    expect(page.objects).toEqual([
      expect.objectContaining({ id: created.event.id, objectType: "event", category: "note" }),
    ]);

    const deleted = await remove.handler({ id: created.event.id }, invocation("event_delete"));
    expect(deleted).toEqual({ success: true });
    expect(ctx.focusEventStore.get(created.event.id)).toBeUndefined();
    expect(ctx.feedStore.getCard(created.event.id)).toBeUndefined();
  });

  it("supports visual-only first-class updates", async () => {
    const { ctx } = createTestApp();
    const save = getTool(ctx, "decision_save");
    const created = await save.handler({
      ...decisionDetails,
      title: "Visual Decision",
      visual: { kind: "mermaid", content: "graph TD\n  A-->B" },
    }, invocation("decision_save"));
    expect(created.decision.visual).not.toBeNull();

    const updated = await save.handler({
      id: created.decision.id,
      visual: null,
    }, invocation("decision_save"));
    expect(updated).toMatchObject({
      success: true,
      created: false,
      decision: { id: created.decision.id, visual: null },
    });
  });

  it("binds keyed visual updates to the object that was inspected", async () => {
    const { ctx } = createTestApp();
    const save = getTool(ctx, "decision_save");
    const created = await save.handler({
      ...decisionDetails,
      key: "decision:visual-owner",
      title: "Bound visual owner",
    }, invocation("decision_save"));
    const updated = await save.handler({
      key: "decision:visual-owner",
      visual: { kind: "mermaid", content: "graph TD\n  Owner-->Stable" },
    }, invocation("decision_save"));

    expect(updated.decision.id).toBe(created.decision.id);
    expect(updated.decision.visual.url).toContain(`/api/feed/${created.decision.id}/visuals/`);
  });

  it("rejects cross-type keyed visual creation with a typed error and cleans up the new artifact", async () => {
    const { ctx } = createTestApp();
    const key = "shared:visual-owner";
    const created = await getTool(ctx, "event_save").handler({
      ...eventDetails(), key, category: "note", title: "Existing Event",
      visual: { kind: "mermaid", content: "graph TD\n  Existing-->Owner" },
    }, invocation("event_save"));
    const original = ctx.focusEventStore.get(created.event.id)!;
    const originalVisualDir = getVisualsDir(ctx.copilotHome!, feedCardVisualOwner(original.id));
    const originalFiles = readdirSync(originalVisualDir);
    const publish = vi.spyOn(visualPublisher, "publishVisualFromToolArgs");
    const save = vi.spyOn(ctx.focusMutationCoordinator, "saveDecision");
    try {
      const result = await getTool(ctx, "decision_save").handler({
        ...decisionDetails, key, title: "Conflicting Decision",
        visual: { kind: "mermaid", content: "graph TD\n  Attempted-->Replacement" },
      }, invocation("decision_save"));

      expect(result.success).not.toBe(true);
      expect(result.error).toBe("dedupeKey belongs to event, not decision");
      expect(save.mock.results).toHaveLength(1);
      expect(save.mock.results[0]).toMatchObject({ type: "throw" });
      expect(save.mock.results[0]!.value).toBeInstanceOf(FeedCardValidationError);
      expect(publish).toHaveBeenCalledTimes(1);
      const published = await publish.mock.results[0]!.value;
      if (!published.ok) throw new Error(published.error);
      const owner = publish.mock.calls[0]![2];
      expect(owner.id).not.toBe(original.id);
      const attemptedVisualDir = getVisualsDir(ctx.copilotHome!, owner);
      expect(existsSync(join(attemptedVisualDir, `${published.value.artifactId}.meta.json`))).toBe(false);
      expect(existsSync(join(attemptedVisualDir, `${published.value.artifactId}.mmd`))).toBe(false);
      expect(readdirSync(attemptedVisualDir)).toEqual([]);
      expect(readdirSync(originalVisualDir)).toEqual(originalFiles);
      expect(ctx.focusEventStore.get(original.id)).toEqual(original);
      expect(ctx.decisionStore.getByKey(key)).toBeUndefined();
    } finally {
      publish.mockRestore();
      save.mockRestore();
    }
  });

  it("uses Action tools as the preferred names over checklist compatibility aliases", async () => {
    const { ctx } = createTestApp();
    const add = getTool(ctx, "action_add");
    const update = getTool(ctx, "action_update");
    const list = getTool(ctx, "action_list");
    const remove = getTool(ctx, "action_remove");

    const created = await add.handler({ text: "First-class Action" }, invocation("action_add"));
    expect(created.action.text).toBe("First-class Action");
    const completed = await update.handler({
      actionId: created.action.id,
      done: true,
    }, invocation("action_update"));
    expect(completed.action.done).toBe(true);
    expect((await list.handler({}, invocation("action_list"))).actions).toHaveLength(1);
    expect(await remove.handler({ actionId: created.action.id }, invocation("action_remove")))
      .toEqual({ success: true });
  });
});

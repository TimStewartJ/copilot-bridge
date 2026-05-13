import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { createBridgeTools } from "../session-manager.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./helpers.js";

function getTool(ctx: AppContext, name: string) {
  const tool = createBridgeTools(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

function createInvocation(toolName: string) {
  return {
    sessionId: "session-1",
    toolCallId: `tool-${toolName}`,
    toolName,
    arguments: {},
  };
}

describe("session manager feed tools", () => {
  it("feed_save creates and updates keyed cards", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");

    const created = await saveTool.handler({
      key: "preview:one",
      title: "Preview building",
      kind: "status",
      priority: "high",
    }, createInvocation("feed_save")) as any;

    expect(created).toEqual(expect.objectContaining({
      success: true,
      created: true,
      card: expect.objectContaining({
        dedupeKey: "preview:one",
        title: "Preview building",
        kind: "status",
        priority: "high",
      }),
    }));

    const updated = await saveTool.handler({
      key: "preview:one",
      title: "Preview ready",
      body: "Open it now",
    }, createInvocation("feed_save")) as any;

    expect(updated).toEqual(expect.objectContaining({
      success: true,
      created: false,
      card: expect.objectContaining({
        id: created.card.id,
        title: "Preview ready",
        body: "Open it now",
      }),
    }));
  });

  it("feed_save updates by id and preserves dismissed keyed cards unless explicit", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");
    const created = await saveTool.handler({
      key: "decision:one",
      title: "Choose path",
    }, createInvocation("feed_save")) as any;

    await expect(saveTool.handler({
      id: created.card.id,
      status: "dismissed",
    }, createInvocation("feed_save"))).resolves.toEqual(expect.objectContaining({
      success: true,
      card: expect.objectContaining({ status: "dismissed" }),
    }));

    const implicit = await saveTool.handler({
      key: "decision:one",
      title: "Choose path updated",
    }, createInvocation("feed_save")) as any;
    expect(implicit.card.status).toBe("dismissed");

    const explicit = await saveTool.handler({
      key: "decision:one",
      status: "active",
    }, createInvocation("feed_save")) as any;
    expect(explicit.card.status).toBe("active");
  });

  it("feed_list defaults to active cards", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");
    const listTool = getTool(ctx, "feed_list");
    await saveTool.handler({ title: "Active" }, createInvocation("feed_save"));
    await saveTool.handler({ title: "Done", status: "done" }, createInvocation("feed_save"));

    await expect(listTool.handler({}, createInvocation("feed_list"))).resolves.toEqual({
      cards: [expect.objectContaining({ title: "Active", status: "active" })],
    });
    const all = await listTool.handler({ includeDismissed: true }, createInvocation("feed_list")) as any;
    expect(all.cards).toHaveLength(2);
    expect(all.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Done", status: "done" }),
      expect.objectContaining({ title: "Active", status: "active" }),
    ]));
  });

  it("feed_save publishes, preserves, replaces, and clears feed visuals", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");

    const created = await saveTool.handler({
      key: "visual:one",
      title: "Visual card",
      visual: { kind: "mermaid", content: "graph TD\n  A-->B" },
    }, createInvocation("feed_save")) as any;

    expect(created).toEqual(expect.objectContaining({
      success: true,
      created: true,
      card: expect.objectContaining({
        visual: expect.objectContaining({
          kind: "mermaid",
          title: "Visual card",
          mimeType: "text/vnd.mermaid",
        }),
      }),
    }));
    expect(created.card.visual.url).toContain(`/api/feed/${created.card.id}/visuals/`);
    expect(created.card.visual.source).toBeUndefined();
    const firstArtifactId = created.card.visual.artifactId;
    const firstMetaPath = join(ctx.copilotHome!, "feed-cards", created.card.id, "visuals", `${firstArtifactId}.meta.json`);
    expect(existsSync(firstMetaPath)).toBe(true);

    const preserved = await saveTool.handler({
      key: "visual:one",
      title: "Visual card renamed",
    }, createInvocation("feed_save")) as any;
    expect(preserved.card.visual.artifactId).toBe(firstArtifactId);

    const replaced = await saveTool.handler({
      key: "visual:one",
      visual: { kind: "html", content: "<p>Hello</p>" },
    }, createInvocation("feed_save")) as any;
    expect(replaced.card.visual).toEqual(expect.objectContaining({ kind: "html", title: "Visual card renamed" }));
    expect(replaced.card.visual.artifactId).not.toBe(firstArtifactId);
    expect(existsSync(firstMetaPath)).toBe(false);
    const secondMetaPath = join(ctx.copilotHome!, "feed-cards", replaced.card.id, "visuals", `${replaced.card.visual.artifactId}.meta.json`);
    expect(existsSync(secondMetaPath)).toBe(true);

    const cleared = await saveTool.handler({
      key: "visual:one",
      visual: null,
    }, createInvocation("feed_save")) as any;
    expect(cleared.card.visual).toBeNull();
    expect(existsSync(secondMetaPath)).toBe(false);
  });

  it("feed_save rejects prebuilt visual references", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");

    await expect(saveTool.handler({
      title: "Bad visual",
      visual: {
        kind: "mermaid",
        content: "graph TD\n  A-->B",
        url: "/api/sessions/s/visuals/11111111-1111-4111-8111-111111111111",
      },
    }, createInvocation("feed_save"))).resolves.toEqual(toolFailure("Unknown visual field(s): url"));
  });

  it("feed_delete requires exactly one identifier", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");
    const deleteTool = getTool(ctx, "feed_delete");
    const created = await saveTool.handler({ key: "delete:one", title: "Delete me" }, createInvocation("feed_save")) as any;

    await expect(deleteTool.handler({}, createInvocation("feed_delete")))
      .resolves.toEqual(toolFailure("Provide exactly one of id or key"));
    await expect(deleteTool.handler({ id: created.card.id, key: "delete:one" }, createInvocation("feed_delete")))
      .resolves.toEqual(toolFailure("Provide exactly one of id or key"));
    await expect(deleteTool.handler({ key: "delete:one" }, createInvocation("feed_delete")))
      .resolves.toEqual({ success: true });
    expect(ctx.feedStore.getCard(created.card.id)).toBeUndefined();
  });

  it("feed_save rejects ambiguous or empty updates", async () => {
    const { ctx } = createTestApp();
    const saveTool = getTool(ctx, "feed_save");

    await expect(saveTool.handler({
      id: "card-id",
      key: "card-key",
      title: "Bad",
    }, createInvocation("feed_save"))).resolves.toEqual(toolFailure("Provide either id or key, not both"));

    await expect(saveTool.handler({
      key: "card-key",
    }, createInvocation("feed_save"))).resolves.toEqual(
      toolFailure("No fields to update. Provide at least one card field besides id/key."),
    );

    await expect(saveTool.handler({
      title: "",
    }, createInvocation("feed_save"))).resolves.toEqual(toolFailure("title is required"));
  });
});

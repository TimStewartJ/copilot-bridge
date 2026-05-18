import { defineTool } from "@github/copilot-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { FeedCardNotFoundError, FeedCardValidationError, type FeedCardStatus } from "../feed-store.js";
import { toolFailure } from "../tool-results.js";
import { deleteVisualArtifactForOwner, feedCardVisualOwner } from "../visual-artifacts.js";
import { publishVisualFromToolArgs, stripVisualSource } from "./visual-tool-publisher.js";

const FEED_SAVE_FIELDS = [
  "id",
  "key",
  "title",
  "body",
  "kind",
  "priority",
  "status",
  "taskId",
  "sessionId",
  "url",
  "links",
  "metadata",
  "action",
  "visual",
  "pinned",
] as const;

const FEED_VISUAL_FIELDS = [
  "kind",
  "title",
  "path",
  "content",
  "mimeType",
  "displayName",
  "caption",
  "altText",
] as const;

function hasOwn(args: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function normalizeFeedToolError(error: unknown) {
  if (error instanceof FeedCardValidationError || error instanceof FeedCardNotFoundError) {
    return toolFailure(error.message);
  }
  return toolFailure(error instanceof Error ? error.message : String(error));
}

function rejectUnknownFields(args: Record<string, unknown>, allowedFields: readonly string[]) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  return unknown.length > 0 ? toolFailure(`Unknown field(s): ${unknown.join(", ")}`) : undefined;
}

function hasFeedMutationFields(args: Record<string, unknown>): boolean {
  return FEED_SAVE_FIELDS.some((field) => field !== "id" && field !== "key" && hasOwn(args, field));
}

function parseFeedStatus(value: unknown): FeedCardStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "active" || value === "done" || value === "dismissed") return value;
  throw new FeedCardValidationError("status must be one of: active, done, dismissed");
}

function stripToolOnlyFields(args: Record<string, unknown>): Record<string, unknown> {
  const updates = { ...args };
  delete updates.id;
  delete updates.visual;
  return updates;
}

function getCardTitle(args: Record<string, unknown>, fallback?: string | null): string | undefined {
  return typeof args.title === "string" && args.title.trim() ? args.title : (fallback ?? undefined);
}

function deletePublishedFeedVisual(ctx: AppContext, cardId: string, artifactId: string): void {
  const deleted = deleteVisualArtifactForOwner(
    ctx.copilotHome ?? join(homedir(), ".copilot"),
    feedCardVisualOwner(cardId),
    artifactId,
  );
  if (!deleted.ok) throw new Error(deleted.error);
}

function normalizeVisualPayload(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FeedCardValidationError("visual must be an object or null");
  }
  const visual = value as Record<string, unknown>;
  const unknown = Object.keys(visual).filter((key) => !(FEED_VISUAL_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new FeedCardValidationError(`Unknown visual field(s): ${unknown.join(", ")}`);
  }
  return visual;
}

export function createFeedTools(ctx: AppContext) {
  return [
    defineTool("feed_save", {
      description: "Create or update a durable dashboard feed card. Use this sparingly for finite, user-relevant queue items that should remain visible after chat, not for narration, progress logs, routine status updates, staging previews, or generic completion summaries. Use key for recurring or ongoing cards you plan to update in place; omit key for distinct historical cards. Optional body supports concise Markdown for scannable text. Optional action defines a prompt preview button that starts a normal user-visible session only after confirmation; omit action to preserve it, or pass null to clear it. Optional visual publishes a feed-owned image, Mermaid diagram, Vega-Lite chart, or sandboxed HTML preview; omit visual to preserve the current visual, or pass null to clear it. To revive a dismissed or done keyed card, explicitly pass status: 'active'.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing card ID to update. Mutually exclusive with key." },
          key: { type: "string", description: "Stable agent-chosen key for upsert/dedupe, e.g. 'platform-audit:slug' or 'decision:task-id:topic'. Mutually exclusive with id." },
          title: { type: "string", description: "Short card title. Required when creating a new card." },
          body: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional concise Markdown body text. Supports GFM-style bullets, links, tables, task lists, and code. Raw HTML is escaped. Null clears it." },
          kind: { type: "string", description: "Card kind. Recommended: note, status, todo, decision, artifact, link. Unknown kinds are allowed." },
          priority: { type: "string", enum: ["low", "normal", "high"], description: "Card priority. Defaults to normal." },
          status: { type: "string", enum: ["active", "done", "dismissed"], description: "Card status. Defaults to active. Set done or dismissed when resolved." },
          taskId: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional related task ID. Null clears it." },
          sessionId: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional related session ID. Null clears it." },
          url: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional primary URL. Null clears it." },
          links: {
            type: "array",
            description: "Optional secondary links. Replaces existing links when updating.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                url: { type: "string" },
              },
              required: ["label", "url"],
            },
          },
          metadata: { type: "object", description: "Optional small JSON object for agent-owned structured data. Replaces existing metadata when updating." },
          action: {
            anyOf: [{
              type: "object",
              properties: {
                label: { type: "string", description: "Optional short button label. Defaults to Start session." },
                prompt: { type: "string", description: "Prompt shown to the user before starting the session. Required when action is provided." },
                taskId: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                  description: "Optional task context override. Omit to inherit the card taskId; pass null to force a standalone session.",
                },
              },
              required: ["prompt"],
            }, { type: "null" }],
            description: "Optional prompt action. First click previews the prompt; user confirmation starts a normal session with this prompt. Null clears the action.",
          },
          visual: {
            anyOf: [{
              type: "object",
              properties: {
                kind: { type: "string", enum: ["image", "mermaid", "vega-lite", "html"] },
                title: { type: "string", description: "Optional visual title. Defaults to the feed card title." },
                path: { type: "string", description: "Absolute path to an existing image file to publish (image kind only)." },
                content: { type: "string", description: "Base64 image bytes, Mermaid source, Vega-Lite JSON spec, or HTML source depending on kind." },
                mimeType: { type: "string", description: "Image MIME type. Inferred from path when omitted." },
                displayName: { type: "string", description: "Optional filename shown in download controls." },
                caption: { type: "string", description: "Optional caption displayed below the visual." },
                altText: { type: "string", description: "Optional alt text for image visuals." },
              },
              required: ["kind"],
            }, { type: "null" }],
            description: "Optional visual publish payload. The server mints the artifact URL; prebuilt visual URLs are not accepted. Null clears the existing visual.",
          },
          pinned: { type: "boolean", description: "Pin the card to the top of the feed." },
        },
        required: [],
      },
      handler: async (args: any) => {
        let cleanupNewVisual: (() => void) | undefined;
        try {
          const unknownFieldFailure = rejectUnknownFields(args, FEED_SAVE_FIELDS);
          if (unknownFieldFailure) return unknownFieldFailure;
          const hasId = typeof args.id === "string" && args.id.trim() !== "";
          const hasKey = typeof args.key === "string" && args.key.trim() !== "";
          const hasVisual = hasOwn(args, "visual");
          const visualPayload = normalizeVisualPayload(args.visual);
          if (hasId && hasKey) return toolFailure("Provide either id or key, not both");
          if ((hasId || hasKey) && !hasFeedMutationFields(args)) {
            return toolFailure("No fields to update. Provide at least one card field besides id/key.");
          }

          const existing = hasId
            ? ctx.feedStore.getCard(args.id)
            : hasKey
              ? ctx.feedStore.getCardByKey(args.key)
              : undefined;
          if (hasId && !existing) throw new FeedCardNotFoundError(`Feed card ${args.id} not found`);

          const cardArgs = stripToolOnlyFields(args);
          const mutationOptions: { createId?: string; visual?: any } = {};
          if (hasVisual) {
            if (visualPayload === null) {
              mutationOptions.visual = null;
            } else if (visualPayload !== undefined) {
              const cardId = existing?.id ?? crypto.randomUUID();
              const published = await publishVisualFromToolArgs(
                ctx,
                visualPayload,
                feedCardVisualOwner(cardId),
                getCardTitle(args, existing?.title),
              );
              if (!published.ok) return toolFailure(published.error);
              mutationOptions.visual = stripVisualSource(published.value);
              mutationOptions.createId = existing ? undefined : cardId;
              cleanupNewVisual = () => deletePublishedFeedVisual(ctx, cardId, published.value.artifactId);
            }
          }

          if (hasId) {
            const card = ctx.feedStore.updateCardById(args.id, cardArgs, mutationOptions);
            return { success: true, created: false, card };
          }
          const result = ctx.feedStore.saveCard(cardArgs, mutationOptions);
          return { success: true, ...result };
        } catch (error) {
          try {
            cleanupNewVisual?.();
          } catch (cleanupError) {
            console.warn(`[feed] Failed to clean up unpublished visual: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
          return normalizeFeedToolError(error);
        }
      },
    }),
    defineTool("feed_list", {
      description: "List durable dashboard feed cards. Defaults to active cards only. Use this to inspect existing cards before updating them; prefer updating keyed cards over creating near-duplicates.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "done", "dismissed"], description: "Filter by status. Defaults to active when omitted." },
          kind: { type: "string", description: "Filter by kind." },
          taskId: { type: "string", description: "Filter by related task ID." },
          sessionId: { type: "string", description: "Filter by related session ID." },
          limit: { type: "number", description: "Maximum cards to return, capped by the server." },
          cursor: { type: "string", description: "Opaque nextCursor from a previous feed_list call for the same filters." },
          includeDismissed: { type: "boolean", description: "When true and status is omitted, include all statuses." },
        },
        required: [],
      },
      handler: async (args: any) => {
        try {
          return ctx.feedStore.listCardPage({
            status: parseFeedStatus(args.status),
            kind: args.kind,
            taskId: args.taskId,
            sessionId: args.sessionId,
            limit: args.limit,
            cursor: args.cursor,
            includeDismissed: args.includeDismissed === true,
          });
        } catch (error) {
          return normalizeFeedToolError(error);
        }
      },
    }),
    defineTool("feed_delete", {
      description: "Delete a durable dashboard feed card by id or key. Prefer setting status to done or dismissed when the card remains useful as history.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Card ID to delete. Mutually exclusive with key." },
          key: { type: "string", description: "Stable card key to delete. Mutually exclusive with id." },
        },
        required: [],
      },
      handler: async (args: any) => {
        const hasId = typeof args.id === "string" && args.id.trim() !== "";
        const hasKey = typeof args.key === "string" && args.key.trim() !== "";
        if (hasId === hasKey) return toolFailure("Provide exactly one of id or key");
        try {
          const deleted = hasId
            ? ctx.feedStore.deleteCardById(args.id)
            : ctx.feedStore.deleteCardByKey(args.key);
          if (!deleted) return toolFailure(`Feed card ${hasId ? args.id : args.key} not found`);
          return { success: true };
        } catch (error) {
          return normalizeFeedToolError(error);
        }
      },
    }),
  ];
}

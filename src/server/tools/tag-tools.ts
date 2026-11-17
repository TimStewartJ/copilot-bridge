import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { ensureTag, ensureTagStore } from "./helpers.js";
import { InvalidTagColorError, TAG_COLORS, type Tag, type TagColor } from "../tag-store.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";

type TagCreateArgs = { name: string; color?: string };
type TagUpdateArgs = { tagId: string; name?: string; color?: string; instructions?: string };
type TagDeleteArgs = { tagId: string };

function isTagColor(value: string): value is TagColor {
  return TAG_COLORS.some((color) => color === value);
}

export interface RegisterTagToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createTagToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("tag_list", {
    description: "List all tags with their IDs, names, and colors",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tags: ctx.tagStore?.listTags().map((t) => ({ id: t.id, name: t.name, color: t.color })) };
    },
  }),
  defineBridgeTool("tag_create", {
    description: "Create a new tag for organizing tasks, groups, and docs",
    parameters: { type: "object", properties: { name: { type: "string", description: "Tag name (e.g., 'python', 'frontend', 'urgent')" }, color: { type: "string", description: "Optional color: blue, purple, amber, rose, cyan, orange, slate, emerald, indigo, pink" } }, required: ["name"] },
    handler: async (args: TagCreateArgs) => {
      const tagStore = ensureTagStore(ctx);
      if (!tagStore.ok) return toolFailure(tagStore.error);
      if (tagStore.value.getTagByName(args.name)) return toolFailure(`Tag "${args.name}" already exists`);
      // createTag picks the next colour for an unknown one, as it does for none.
      const color = args.color !== undefined && isTagColor(args.color) ? args.color : undefined;
      const tag = tagStore.value.createTag(args.name, color);
      return { success: true, message: `Tag "${tag.name}" created`, tagId: tag.id };
    },
  }),
  defineBridgeTool("tag_update", {
    description: "Update a tag's name, color, or instructions",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID" }, name: { type: "string", description: "New name" }, color: { type: "string", description: "New color" }, instructions: { type: "string", description: "Custom instructions for sessions with this tag" } }, required: ["tagId"] },
    handler: async (args: TagUpdateArgs) => {
      const tagStore = ensureTagStore(ctx);
      if (!tagStore.ok) return toolFailure(tagStore.error);
      const tag = ensureTag(ctx, args.tagId);
      if (!tag.ok) return toolFailure(tag.error);
      const updates: Partial<Pick<Tag, "name" | "color" | "instructions">> = {};
      if (args.name !== undefined) {
        const existingTag = tagStore.value.getTagByName(args.name);
        if (existingTag && existingTag.id !== args.tagId) return toolFailure(`Tag "${args.name}" already exists`);
        updates.name = args.name;
      }
      if (args.color !== undefined) {
        // Same refusal updateTag throws for an unknown colour.
        if (!isTagColor(args.color)) return toolFailure(new InvalidTagColorError(args.color).message);
        updates.color = args.color;
      }
      if (args.instructions !== undefined) updates.instructions = args.instructions;
      if (Object.keys(updates).length === 0) return toolFailure("Provide at least one of: name, color, instructions");
      try {
        tagStore.value.updateTag(args.tagId, updates);
      } catch (error) {
        if (error instanceof InvalidTagColorError) return toolFailure(error.message);
        throw error;
      }
      // Only name and instructions feed prompts; a colour change must not evict every session.
      if (updates.name !== undefined || updates.instructions !== undefined) {
        await ctx.sessionManager.evictAllCachedSessions();
      }
      return { success: true, message: `Tag updated` };
    },
  }),
  defineBridgeTool("tag_delete", {
    description: "Delete a tag. Removes it from all entities.",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID to delete" } }, required: ["tagId"] },
    handler: async (args: TagDeleteArgs) => {
      const deleted = ctx.tagStore?.deleteTag(args.tagId) ?? false;
      if (!deleted) return toolFailure(`Tag ${args.tagId} not found`);
      await ctx.sessionManager.evictAllCachedSessions();
      return { success: true, message: "Tag deleted" };
    },
  }),
  ];
}

export function registerTagTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterTagToolsOptions = {},
): void {
  const definitions = createTagToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}

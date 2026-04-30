import { defineTool } from "@github/copilot-sdk";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { ensureTag, ensureTagStore } from "./helpers.js";

export function createTagTools(ctx: AppContext) {
  return [
  defineTool("tag_list", {
    description: "List all tags with their IDs, names, and colors",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tags: ctx.tagStore?.listTags().map((t) => ({ id: t.id, name: t.name, color: t.color })) };
    },
  }),
  defineTool("tag_create", {
    description: "Create a new tag for organizing tasks, groups, and docs",
    parameters: { type: "object", properties: { name: { type: "string", description: "Tag name (e.g., 'python', 'frontend', 'urgent')" }, color: { type: "string", description: "Optional color: blue, purple, amber, rose, cyan, orange, slate, emerald, indigo, pink" } }, required: ["name"] },
    handler: async (args: any) => {
      const tagStore = ensureTagStore(ctx);
      if (!tagStore.ok) return toolFailure(tagStore.error);
      if (tagStore.value.getTagByName(args.name)) return toolFailure(`Tag "${args.name}" already exists`);
      const tag = tagStore.value.createTag(args.name, args.color);
      return { success: true, message: `Tag "${tag.name}" created`, tagId: tag.id };
    },
  }),
  defineTool("tag_update", {
    description: "Update a tag's name, color, or instructions",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID" }, name: { type: "string", description: "New name" }, color: { type: "string", description: "New color" }, instructions: { type: "string", description: "Custom instructions for sessions with this tag" } }, required: ["tagId"] },
    handler: async (args: any) => {
      const tagStore = ensureTagStore(ctx);
      if (!tagStore.ok) return toolFailure(tagStore.error);
      const tag = ensureTag(ctx, args.tagId);
      if (!tag.ok) return toolFailure(tag.error);
      const updates: Record<string, any> = {};
      if (args.name !== undefined) {
        const existingTag = tagStore.value.getTagByName(args.name);
        if (existingTag && existingTag.id !== args.tagId) return toolFailure(`Tag "${args.name}" already exists`);
        updates.name = args.name;
      }
      if (args.color !== undefined) updates.color = args.color;
      if (args.instructions !== undefined) updates.instructions = args.instructions;
      if (Object.keys(updates).length === 0) return toolFailure("Provide at least one of: name, color, instructions");
      tagStore.value.updateTag(args.tagId, updates);
      ctx.sessionManager.evictAllCachedSessions();
      return { success: true, message: `Tag updated` };
    },
  }),
  defineTool("tag_delete", {
    description: "Delete a tag. Removes it from all entities.",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID to delete" } }, required: ["tagId"] },
    handler: async (args: any) => {
      ctx.tagStore?.deleteTag(args.tagId);
      ctx.sessionManager.evictAllCachedSessions();
      return { success: true, message: "Tag deleted" };
    },
  }),
  ];
}

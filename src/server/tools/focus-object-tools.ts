import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import {
  FeedCardNotFoundError,
  FeedCardValidationError,
  type FeedCardVisual,
} from "../feed-store.js";
import type { FocusObject, FocusObjectType } from "../focus-domain-store.js";
import { FOCUS_DETAIL_FIELDS, FOCUS_LIFECYCLES } from "../focus-details-store.js";
import { toolFailure } from "../tool-results.js";
import { deleteVisualArtifactForOwner, feedCardVisualOwner } from "../visual-artifacts.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";
import {
  publishVisualFromToolArgs,
  stripVisualSource,
  VISUAL_CONTENT_TYPE_SCHEMA,
  VISUAL_KIND_SCHEMA,
} from "./visual-tool-publisher.js";

const COMMON_SAVE_FIELDS = [
  "id",
  "key",
  "title",
  "body",
  "priority",
  "status",
  "taskId",
  "sessionId",
  "url",
  "links",
  "metadata",
  "launchPrompt",
  "visual",
  "pinned",
  ...FOCUS_DETAIL_FIELDS,
  "question",
  "lifecycleReason",
  "newEpisode",
  "expectedActivationId",
  "recurring",
] as const;

const VISUAL_FIELDS = [
  "kind",
  "title",
  "path",
  "content",
  "mimeType",
  "displayName",
  "caption",
  "altText",
] as const;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function serializeFocusObject(object: FocusObject) {
  const { action, kind: _legacyKind, ...rest } = object;
  return { ...rest, launchPrompt: action };
}

function normalizeError(error: unknown) {
  if (error instanceof FeedCardValidationError || error instanceof FeedCardNotFoundError) {
    return toolFailure(error.message);
  }
  return toolFailure(error instanceof Error ? error.message : String(error));
}

function rejectUnknownFields(args: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  return unknown.length > 0 ? toolFailure(`Unknown field(s): ${unknown.join(", ")}`) : undefined;
}

function normalizeVisualPayload(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FeedCardValidationError("visual must be an object or null");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(VISUAL_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new FeedCardValidationError(`Unknown visual field(s): ${unknown.join(", ")}`);
  return record;
}

function stripToolFields(args: Record<string, unknown>): Record<string, unknown> {
  const input = { ...args };
  delete input.id;
  delete input.visual;
  delete input.category;
  if (hasOwn(input, "launchPrompt")) {
    input.action = input.launchPrompt;
    delete input.launchPrompt;
  }
  return input;
}

function getExisting(ctx: AppContext, objectType: FocusObjectType, id?: string, key?: string): FocusObject | undefined {
  if (id) {
    const object = ctx.focusMutationCoordinator.getAny(id);
    return object?.objectType === objectType ? object : undefined;
  }
  if (!key) return undefined;
  const store = objectType === "decision"
    ? ctx.decisionStore
    : objectType === "alert"
      ? ctx.alertStore
      : ctx.focusEventStore;
  return store.getByKey(key);
}

function deletePublishedVisual(ctx: AppContext, objectId: string, artifactId: string): void {
  const deleted = deleteVisualArtifactForOwner(
    ctx.copilotHome ?? join(homedir(), ".copilot"),
    feedCardVisualOwner(objectId),
    artifactId,
  );
  if (!deleted.ok) throw new Error(deleted.error);
}

const visualSchema = {
  anyOf: [{
    type: "object",
    properties: {
      kind: { ...VISUAL_KIND_SCHEMA },
      title: { type: "string" },
      path: { type: "string" },
      content: { ...VISUAL_CONTENT_TYPE_SCHEMA },
      mimeType: { type: "string" },
      displayName: { type: "string" },
      caption: { type: "string" },
      altText: { type: "string" },
    },
    required: ["kind"],
  }, { type: "null" }],
};

function commonSaveProperties() {
  return {
    id: { type: "string", description: "Existing object ID to update. Mutually exclusive with key." },
    key: { type: "string", description: "Stable dedupe key for keyed upsert. Mutually exclusive with id." },
    title: { type: "string", description: "Short title. Required when creating." },
    body: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional concise Markdown body." },
    priority: { type: "string", enum: ["low", "normal", "high"] },
    status: { type: "string", enum: ["active", "done", "dismissed"] },
    lifecycle: { type: "string", enum: [...FOCUS_LIFECYCLES], description: "Truthful lifecycle. Launching acknowledges; promotion hands off. Resolved/accepted_risk/dismissed require a reason/outcome, never merely a session or Action." },
    lifecycleReason: { type: "string", description: "Why this lifecycle change is warranted." },
    newEpisode: { type: "boolean", description: "Required to reactivate any cleared concern; also supply a new episodeReason." },
    expectedActivationId: { type: "string", description: "Optimistic guard copied from the object; rejects stale episode mutations." },
    episodeReason: { type: ["string", "null"], description: "New evidence or changed circumstances justifying a new episode, not routine repetition." },
    question: { type: "string", description: "Decision question; may supply the creation title." },
    sourceFamily: { type: ["string", "null"], description: "Stable source family; defines digest grouping independently of the key prefix." },
    producer: { type: ["string", "null"], description: "Identifiable observation producer; never impersonate the reserved legacy producer." },
    observedAt: { type: ["string", "null"], description: "Evidence observation time (ISO timestamp with timezone), not the publication time." },
    validUntil: { type: ["string", "null"], description: "When this evidence ceases to be valid." },
    interventionBy: { type: ["string", "null"], description: "When human intervention is needed, ISO timestamp with timezone." },
    evidence: { type: "array", items: { anyOf: [
      { type: "string" },
      { type: "object", properties: { summary: { type: "string" }, url: { type: "string" }, observedAt: { type: "string" } }, required: ["summary"], additionalProperties: false },
    ] }, description: "Concrete verified observations, not inferred urgency." },
    impact: { type: ["string", "null"], description: "Specific impact of the verified Alert condition." },
    consequenceOfDelay: { type: ["string", "null"], description: "Required for a Decision with an intervention deadline." },
    alternatives: { type: "array", items: { type: "string" }, description: "At least two distinct feasible Decision alternatives." },
    recommendation: { type: ["string", "null"] },
    fallback: { type: ["string", "null"], description: "Safe default if the user does not decide." },
    outcome: { type: ["string", "null"], description: "Actual verified result, not a planned action or session start." },
    resolutionReason: { type: ["string", "null"] },
    notificationMode: { type: "string", enum: ["focus", "summary", "immediate"], description: "Separate from persistence/priority. Immediate is restricted to verified Alerts with active matching Reach authority and delivery policy." },
    authorizationGrantId: { type: ["string", "null"], description: "Existing user-approved authority grant. Grants are re-evaluated at delivery." },
    recurring: { type: "boolean", description: "Recurring/producer output requires a stable key. Reuse a concern's key; never append dates merely to create attention." },
    taskId: { anyOf: [{ type: "string" }, { type: "null" }] },
    sessionId: { anyOf: [{ type: "string" }, { type: "null" }] },
    url: { anyOf: [{ type: "string" }, { type: "null" }] },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, url: { type: "string" } },
        required: ["label", "url"],
      },
    },
    metadata: { type: "object" },
    launchPrompt: {
      anyOf: [{
        type: "object",
        properties: {
          label: { type: "string" },
          prompt: { type: "string" },
          taskId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["prompt"],
      }, { type: "null" }],
    },
    visual: { ...visualSchema },
    pinned: { type: "boolean" },
  };
}

function createObjectSaveTool(
  ctx: AppContext,
  objectType: FocusObjectType,
): BridgeToolDefinition {
  const singular = objectType;
  const toolName = `${objectType}_save`;
  const allowedFields = objectType === "event"
    ? [...COMMON_SAVE_FIELDS, "category"]
    : COMMON_SAVE_FIELDS;
  return defineBridgeTool(toolName, {
    description: objectType === "decision"
      ? "Create/update a Decision only for a real user choice: title/question, >=2 alternatives, recommendation or fallback, and consequenceOfDelay when interventionBy is set. Chat by default. Do not duplicate a concern as an Alert/Event/Action. Use a stable concern key; dismissal is sticky until newEpisode:true with episodeReason. Session launch only acknowledges; promotion only hands off. Resolve only from a verified outcome."
      : objectType === "alert"
        ? "Create/update a verified Alert only with evidence, impact, observedAt, sourceFamily, producer, and interventionBy. Persistence and push are separate: immediate delivery additionally requires active user-approved authority and policy eligibility. Chat by default; never duplicate the same concern in multiple types or reactivate a dismissal without a justified new episode."
        : "Create/update a durable Event only with category, sourceFamily, producer, observedAt, and a stable producer/concern key. Prefer chat for routine completion, narration and test results. Events are quiet digest material, never immediate notifications or disguised Decisions/Alerts. Repeated identical output must reuse its key; do not manufacture freshness.",
    parameters: {
      type: "object",
      properties: {
        ...commonSaveProperties(),
        ...(objectType === "event"
          ? { category: { type: "string", description: "Event category, such as note, link, deal, status, or artifact." } }
          : {}),
      },
      required: [],
    },
    handler: async (args: any) => {
      let cleanupNewVisual: (() => void) | undefined;
      try {
        const unknown = rejectUnknownFields(args, allowedFields);
        if (unknown) return unknown;
        for (const field of ["id", "key"]) {
          if (hasOwn(args, field) && (typeof args[field] !== "string" || !args[field].trim())) {
            throw new FeedCardValidationError(`${field} must be a non-empty string`);
          }
        }
        const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
        const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : undefined;
        if (id && key) return toolFailure("Provide either id or key, not both");
        const existing = getExisting(ctx, objectType, id, key);
        if (id && !existing) return toolFailure(`${singular} ${id} not found`);
        const hasMutation = Object.keys(args).some((field) => field !== "id" && field !== "key");
        if ((id || key) && existing && !hasMutation && !hasOwn(args, "visual")) {
          return toolFailure("No fields to update");
        }

        let category: string | undefined;
        if (objectType === "event") {
          if (hasOwn(args, "category") && (typeof args.category !== "string" || !args.category.trim())) {
            throw new FeedCardValidationError("category must be a non-empty string");
          }
          category = typeof args.category === "string" && args.category.trim()
            ? args.category.trim()
            : existing?.objectType === "event"
              ? existing.category
              : undefined;
          if (!category) return toolFailure("category is required when creating an event");
        }

        const visualPayload = normalizeVisualPayload(args.visual);
        const mutationOptions: { createId?: string; visual?: FeedCardVisual | null } = {};
        if (hasOwn(args, "visual")) {
          if (visualPayload === null) {
            mutationOptions.visual = null;
          } else if (visualPayload !== undefined) {
            const objectId = existing?.id ?? crypto.randomUUID();
            const published = await publishVisualFromToolArgs(
              ctx,
              visualPayload,
              feedCardVisualOwner(objectId),
              typeof args.title === "string" ? args.title : existing?.title,
            );
            if (!published.ok) return toolFailure(published.error);
            mutationOptions.visual = stripVisualSource(published.value) as FeedCardVisual;
            mutationOptions.createId = existing ? undefined : objectId;
            cleanupNewVisual = () => deletePublishedVisual(ctx, objectId, published.value.artifactId);
          }
        }
        const input = stripToolFields(args);
        const updateId = id ?? existing?.id;
        if (updateId) delete input.key;
        let result: { created: boolean; object: FocusObject };
        if (objectType === "decision") {
          if (updateId) {
            result = {
              created: false,
              object: ctx.focusMutationCoordinator.updateDecision(updateId, input, mutationOptions),
            };
          } else {
            const saved = ctx.focusMutationCoordinator.saveDecision(input, mutationOptions);
            result = { created: saved.created, object: saved.decision };
          }
        } else if (objectType === "alert") {
          if (updateId) {
            result = {
              created: false,
              object: ctx.focusMutationCoordinator.updateAlert(updateId, input, mutationOptions),
            };
          } else {
            const saved = ctx.focusMutationCoordinator.saveAlert(input, mutationOptions);
            result = { created: saved.created, object: saved.alert };
          }
        } else {
          if (updateId) {
            result = {
              created: false,
              object: ctx.focusMutationCoordinator.updateEvent(updateId, category!, input, mutationOptions),
            };
          } else {
            const saved = ctx.focusMutationCoordinator.saveEvent(category!, input, mutationOptions);
            result = { created: saved.created, object: saved.event };
          }
        }
        return {
          success: true,
          created: result.created,
          [singular]: serializeFocusObject(result.object),
        };
      } catch (error) {
        try {
          cleanupNewVisual?.();
        } catch (cleanupError) {
          console.warn(`[focus-tools] Failed to clean up unpublished visual: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
        return normalizeError(error);
      }
    },
  });
}

function createObjectListTool(ctx: AppContext, objectType: FocusObjectType): BridgeToolDefinition {
  return defineBridgeTool(`${objectType}_list`, {
    description: `List first-class ${objectType}s with offset pagination.`,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "done", "dismissed"] },
        lifecycle: { type: "string", enum: [...FOCUS_LIFECYCLES] },
        taskId: { type: ["string", "null"] },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: [],
    },
    handler: async (args: any) => {
      try {
        const unknown = rejectUnknownFields(args, ["status", "lifecycle", "taskId", "offset", "limit"]);
        if (unknown) return unknown;
        const store = objectType === "decision"
          ? ctx.decisionStore
          : objectType === "alert"
            ? ctx.alertStore
            : ctx.focusEventStore;
        const page = store.listPage({
          status: args.status,
          offset: args.offset,
          limit: args.limit,
          lifecycle: args.lifecycle,
          taskId: args.taskId,
        });
        return {
          objects: page.objects.map(serializeFocusObject),
          total: page.total,
          nextOffset: page.nextOffset,
        };
      } catch (error) {
        return normalizeError(error);
      }
    },
  });
}

function createObjectDeleteTool(ctx: AppContext, objectType: FocusObjectType): BridgeToolDefinition {
  return defineBridgeTool(`${objectType}_delete`, {
    description: `Delete a first-class ${objectType}. Prefer resolving or dismissing it when history remains useful.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        key: { type: "string" },
      },
      required: [],
    },
    handler: async (args: any) => {
      const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
      const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : undefined;
      if (Boolean(id) === Boolean(key)) return toolFailure("Provide exactly one of id or key");
      const existing = getExisting(ctx, objectType, id, key);
      if (!existing) return toolFailure(`${objectType} not found`);
      try {
        ctx.focusMutationCoordinator.deleteById(existing.id);
        return { success: true };
      } catch (error) {
        return normalizeError(error);
      }
    },
  });
}

function createObjectPromoteTool(ctx: AppContext, objectType: FocusObjectType): BridgeToolDefinition {
  return defineBridgeTool(`${objectType}_promote`, {
    description: `Accept executable work from a ${objectType}. Reuses any unfinished linked Action across episodes. Transitions the source to handed_off (legacy status stays active); never resolves it. Omit taskId only for an active, unmuted source task; pass null explicitly for a global destination.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" }, text: { type: "string" },
        taskId: { type: ["string", "null"] }, expectedActivationId: { type: "string" },
      },
      required: ["id"], additionalProperties: false,
    },
    handler: async (args: any) => {
      try {
        const unknown = rejectUnknownFields(args, ["id", "text", "taskId", "expectedActivationId"]);
        if (unknown) return unknown;
        const source = getExisting(ctx, objectType, args.id);
        if (!source) throw new FeedCardNotFoundError(`${objectType} not found`);
        const { id: _id, ...input } = args;
        const result = ctx.focusMutationCoordinator.promoteToAction(source.id, ctx.checklistStore, input, "agent");
        return { success: true, ...result, object: serializeFocusObject(result.object) };
      } catch (error) {
        return normalizeError(error);
      }
    },
  });
}

export function createFocusObjectToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return (["decision", "alert", "event"] as const).flatMap((objectType) => [
    createObjectSaveTool(ctx, objectType),
    createObjectListTool(ctx, objectType),
    createObjectDeleteTool(ctx, objectType),
    createObjectPromoteTool(ctx, objectType),
  ]);
}

export function registerFocusObjectTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: { hiddenTools?: ReadonlySet<string> } = {},
): void {
  registerBridgeToolDefinitions(
    server,
    createFocusObjectToolDefinitions(ctx).filter((tool) => !options.hiddenTools?.has(tool.name)),
  );
}

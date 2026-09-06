import type { AppContext } from "../app-context.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "../feed-store.js";
import { FOCUS_LIFECYCLES, focusEnum, focusInteger, focusRecord, focusText } from "../focus-details-store.js";
import { FOCUS_AUDIT_CATEGORIES } from "../focus-attention-store.js";
import { normalizeFocusReadFilters } from "../focus-dashboard-projection.js";
import { serializeFocusHistoryPage, serializeFocusObject } from "../focus-serialization.js";
import { toolFailure } from "../tool-results.js";
import { defineBridgeTool, registerBridgeToolDefinitions, type BridgeToolDefinition, type BridgeToolsMcpServer } from "../agent-tools-mcp/index.js";

const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const pageFields = { limit: integer, offset: integer };
const readFilterFields = {
  query: { type: "string", minLength: 1, maxLength: 500 },
  taskId: text, originalTaskId: text, sourceFamily: text, activationId: text,
  lifecycle: { type: "string", enum: [...FOCUS_LIFECYCLES] },
};
const scopeFields = {
  id: text, key: text, title: text, taskId: nullableText, sourceFamily: text, producer: text, scope: text,
};
const authorityFields = {
  ...scopeFields, status: { type: "string", enum: ["active", "revoked"] }, validFrom: text, validUntil: text,
  allowImmediate: boolean, allowQuietHoursOverride: boolean, constraints: { type: "array", items: text },
  grantedBy: text, revokeReason: nullableText,
};
const coverageFields = {
  ...scopeFields, explicitState: { type: "string", enum: ["valid", "broken", "unknown"] },
  lastCheckedAt: nullableText, validUntil: nullableText, interventionBy: nullableText,
  expectedIntervalMinutes: integer, atRiskMinutes: integer,
  evidence: { type: "array", items: { anyOf: [text, {
    type: "object", properties: { summary: text, url: text, observedAt: text }, required: ["summary"], additionalProperties: false,
  }] } }, reason: nullableText, authorityGrantId: nullableText,
};
const auditFields = {
  id: text, objectId: nullableText, title: text,
  category: { type: "string", enum: [...FOCUS_AUDIT_CATEGORIES] },
  severity: { type: "string", enum: ["low", "normal", "high"] },
  status: { type: "string", enum: ["open", "resolved", "dismissed"] }, notes: text, outcome: nullableText,
};

function createTool(
  name: string, description: string, properties: Record<string, object>, required: string[],
  handler: (args: Record<string, unknown>) => unknown,
): BridgeToolDefinition {
  return defineBridgeTool(name, {
    description, parameters: { type: "object", properties, required, additionalProperties: false },
    handler: async (input: unknown) => {
      try {
        const args = focusRecord(input, Object.keys(properties));
        for (const field of required) if (args[field] === undefined) throw new FeedCardValidationError(`${field} is required`);
        return handler(args);
      } catch (error) {
        if (error instanceof FeedCardNotFoundError || error instanceof FeedCardValidationError) return toolFailure(error.message);
        throw error;
      }
    },
  });
}

function page(args: Record<string, unknown>) {
  return {
    limit: focusInteger(args.limit ?? 50, "limit", 1, 100),
    offset: focusInteger(args.offset ?? 0, "offset", 0, 1_000_000),
  };
}

export function createFocusGovernanceToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  function changed<T>(result: T): T {
    ctx.globalBus.emit({ type: "focus:changed", reason: "governance-changed", meaningful: true });
    return result;
  }
  const tools: BridgeToolDefinition[] = [];
  for (const operation of ["save", "update"] as const) {
    tools.push(createTool(
      `focus_authority_${operation}`,
      "Record Reach authority only when the user explicitly approved its exact scope, sourceFamily, producer, task, validity and constraints. Never infer or grant yourself permission. Immediate delivery and quiet-hour override require separate explicit flags. Null taskId is global-only, not a wildcard; grants are re-evaluated at delivery.",
      authorityFields, operation === "update" ? ["id"] : [],
      (args) => changed({ grant: ctx.focusAuthorityStore.save(args, "agent") }),
    ));
    tools.push(createTool(
      `focus_coverage_${operation}`,
      "Record a Shelter coverage assertion with bounded provenance and evidence, not an all-clear claim. Valid assertions require lastCheckedAt, validUntil and evidence. At-risk/expired states are computed at read time. Bind autonomy to an existing user-approved authorityGrantId.",
      coverageFields, operation === "update" ? ["id"] : [],
      (args) => changed({ assertion: ctx.focusCoverageStore.save(args, "agent") }),
    ));
    tools.push(createTool(
      `focus_audit_${operation}`,
      "Record or update a Focus attention-quality exception: false positive, missed attention, stale/classification/leakage/notification/coverage error. Include specific notes; closing requires a verified outcome.",
      auditFields, operation === "update" ? ["id"] : [],
      (args) => changed({ audit: ctx.focusAuditStore.save(args, "agent") }),
    ));
  }
  tools.push(
    createTool("focus_protection_current",
      "Read the current user-controlled protected concentration window from durable state. Check before assuming automatic work can start. Only new automatic schedule/defer starts pause; manual starts, admitted in-flight work, recovery and worker returns continue. External systems are not frozen. Agents cannot infer, create, extend or cancel protection.",
      {}, [], () => {
        const now = Date.now();
        return { generatedAt: new Date(now).toISOString(), current: ctx.focusProtectionStore.current(now),
          upcoming: ctx.focusProtectionStore.upcoming(now) };
      }),
    createTool("focus_protection_list",
      "Read protection window history and scheduled windows with status derived from absolute instants. Read-only: protection is controlled only by the user, never inferred or changed by an agent.",
      pageFields, [], (args) => {
        const now = Date.now();
        return { generatedAt: new Date(now).toISOString(), windows: ctx.focusProtectionStore.list(page(args), now) };
      }),
    createTool("focus_authority_list", "List explicit Reach authority grants, including revocations/expiry. Do not treat a stored active flag as current authorization; validity and scope also apply.",
      { status: authorityFields.status, ...pageFields }, [],
      (args) => ({ grants: ctx.focusAuthorityStore.list({
        ...page(args), ...(args.status === undefined ? {} : { status: focusEnum(args.status, "status", ["active", "revoked"] as const) }),
      }) })),
    createTool("focus_authority_revoke", "Revoke a user-approved Reach grant immediately. Pending notifications re-evaluate this revocation before sending.",
      { id: text, reason: text }, ["id", "reason"],
      (args) => changed({ grant: ctx.focusAuthorityStore.revoke(focusText(args.id, "id")!, focusText(args.reason, "reason")!, "agent") })),
    createTool("focus_coverage_list", "List Shelter assertions with computed valid/at-risk/expired/broken/unknown state, observation gaps and constrained autonomy.",
      pageFields, [], (args) => ({ assertions: ctx.focusCoverageStore.list(page(args)) })),
    createTool("focus_coverage_delete", "Delete an obsolete coverage assertion; do not hide a broken monitor by deleting it instead of reporting the gap.",
      { id: text }, ["id"], (args) => changed({ deleted: ctx.focusCoverageStore.remove(focusText(args.id, "id")!) })),
    createTool("focus_audit_list", "List bounded attention-quality audits; open entries are surfaced as Focus exceptions.",
      { status: auditFields.status, ...pageFields }, [], (args) => ({ audits: ctx.focusAuditStore.list({
        ...page(args), ...(args.status === undefined ? {} : { status: focusEnum(args.status, "status", ["open", "resolved", "dismissed"] as const) }),
      }) })),
    createTool("focus_history_list", "Search object-scoped History, including suppressed open concerns, aged Events, Actions and deleted objects. Filters apply together to a current or retained historical state. query searches title/body/outcome/resolution/source/task titles. matchedEpisode/matchedTransition expose the actual match even beyond the latest 100 transitions; object remains today's state. Pages count objects, not transitions.",
      { objectId: text, objectType: { type: "string", enum: ["decision", "alert", "event", "action"] }, ...readFilterFields, ...pageFields }, [],
      (args) => serializeFocusHistoryPage(ctx.focusProjection.listHistory({
        ...normalizeFocusReadFilters(args),
        ...page(args), ...(args.objectId === undefined ? {} : { objectId: focusText(args.objectId, "objectId")! }),
        ...(args.objectType === undefined ? {} : { objectType: focusEnum(args.objectType, "objectType", ["decision", "alert", "event", "action"] as const) }),
      }))),
    createTool("focus_episode_get", "Read a canonical object's exact activation without changing it. currentObject is today's object; previousEpisode is the latest retained snapshot for the requested activation. Matching transitions include snapshots retained by a later activation. historyIncomplete means only older transition records survive; never infer an outcome.",
      { objectId: text, activationId: text, ...pageFields }, ["objectId", "activationId"], (args) => {
        const episode = ctx.focusProjection.getEpisode(focusText(args.objectId, "objectId")!, focusText(args.activationId, "activationId")!, page(args));
        return { ...episode, currentObject: episode.currentObject ? serializeFocusObject(episode.currentObject) : null };
      }),
    createTool("focus_quiet_concerns_list", "Retrieve suppressed concerns, not Event digests or unread counts: open Decisions and handed-off Alerts on muted/archived/orphaned tasks. Active/acknowledged Alerts remain direct attention and are excluded; overdue handoffs are surfaced separately and excluded. Filters match current state; attentionVisible is false and suppressionReason preserves provenance.",
      { objectType: { type: "string", enum: ["decision", "alert"] }, ...readFilterFields, ...pageFields }, [], (args) => {
        const concerns = ctx.focusProjection.listQuietConcerns({
          ...page(args), ...normalizeFocusReadFilters(args),
          ...(args.objectType === undefined ? {} : { objectType: focusEnum(args.objectType, "objectType", ["decision", "alert"] as const) }),
        });
        return { ...concerns, objects: concerns.objects.map((object) => ({
          ...serializeFocusObject(object), attentionVisible: object.attentionVisible, suppressionReason: object.suppressionReason,
        })) };
      }),
    createTool("focus_digest_mark_viewed", "Mark a digest viewed only after the user actually reviewed it. Copy digestId from the snapshot; newCount then reflects meaningful changes since that view.",
      { digestId: text, viewedAt: text }, ["digestId"],
      (args) => changed({ view: ctx.focusProjection.markDigestViewed(focusText(args.digestId, "digestId")!, args.viewedAt === undefined ? undefined : focusText(args.viewedAt, "viewedAt")!) })),
    createTool("focus_quality_metrics", "Read bounded aggregate Focus pilot metrics (1-90 days): no-op rate, mutations, notifications, suppression and audit categories. These are observations, not automatic success claims.",
      { days: integer }, [], (args) => {
        const days = focusInteger(args.days ?? 7, "days", 1, 90);
        ctx.focusNotificationDeliveryStore.reconcileStaleClaims();
        return ctx.focusAttentionStore.metrics({ days });
      }),
  );
  return tools;
}

export function registerFocusGovernanceTools(
  server: BridgeToolsMcpServer, ctx: AppContext, options: { hiddenTools?: ReadonlySet<string> } = {},
): void {
  registerBridgeToolDefinitions(server, createFocusGovernanceToolDefinitions(ctx).filter((tool) => !options.hiddenTools?.has(tool.name)));
}

import type { DatabaseSync } from "./db.js";
import { hydrateRowsSafely, type RowHydrationContext } from "./store-row-hydration.js";
import { isRecord } from "../shared/is-record.js";
import type { ChecklistItem, ChecklistStore } from "./checklist-store.js";
import type { FocusMutationCoordinator } from "./focus-mutation-coordinator.js";

const FEED_CARD_HYDRATION: RowHydrationContext<any> = {
  store: "feed-cards",
  describeRow: (row) => `${String(row?.id ?? "<no id>")} ("${String(row?.title ?? "")}")`,
};

export type FeedCardStatus = "active" | "done" | "dismissed";
export type FeedCardPriority = "low" | "normal" | "high";

export interface FeedCardLink {
  label: string;
  url: string;
}

export interface FeedCardVisual {
  artifactId: string;
  kind: "image" | "mermaid" | "vega-lite" | "html";
  title: string;
  displayName: string;
  mimeType: string;
  size: number;
  url: string;
  downloadUrl: string;
  caption?: string;
  altText?: string;
}

export interface FeedCardAction {
  label?: string;
  prompt: string;
  taskId?: string | null;
}

export interface FeedCard {
  id: string;
  dedupeKey: string | null;
  title: string;
  body: string | null;
  kind: string;
  priority: FeedCardPriority;
  status: FeedCardStatus;
  taskId: string | null;
  sessionId: string | null;
  url: string | null;
  links: FeedCardLink[];
  metadata: Record<string, unknown> | null;
  visual: FeedCardVisual | null;
  action: FeedCardAction | null;
  pinned: boolean;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedCardSummary {
  id: string;
  dedupeKey: string | null;
  title: string;
  kind: string;
  status: FeedCardStatus;
  priority: FeedCardPriority;
  taskId: string | null;
  updatedAt: string;
}

export interface FeedCardPageFilters {
  status?: FeedCardStatus;
  kind?: string;
  taskId?: string;
  sessionId?: string;
  keyPrefix?: string;
  includeDismissed?: boolean;
  limit?: number;
  cursor?: string;
}

export interface FeedCardMinimalPageFilters extends FeedCardPageFilters {
  minimal: true;
}

interface FeedCardPageMeta {
  nextCursor: string | null;
  returnedCount: number;
  hasMore: boolean;
}

export interface FeedCardListPage extends FeedCardPageMeta {
  cards: FeedCard[];
}

export interface FeedCardSummaryListPage extends FeedCardPageMeta {
  cards: FeedCardSummary[];
}

export interface FeedKindStat {
  kind: string;
  total: number;
  active: number;
  done: number;
  dismissed: number;
  lastActivityAt: string | null;
  buckets: number[];
}

export interface FeedKindStats {
  generatedAt: string;
  windowDays: number;
  bucketCount: number;
  windowStart: string;
  windowEnd: string;
  total: number;
  active: number;
  buckets: number[];
  kinds: FeedKindStat[];
}

export interface FeedKindStatsOptions {
  now?: number;
  days?: number;
  buckets?: number;
  keyPrefix?: string;
}

export interface DashboardFocusDigestSample {
  id: string;
  title: string;
  kind: string;
  priority: FeedCardPriority;
  updatedAt: string;
}

export interface DashboardFocusDigest {
  id: string;
  family: string;
  keyPrefix: string | null;
  kind: string | null;
  taskId: string | null;
  taskTitle: string | null;
  quiet: boolean;
  count: number;
  highPriorityCount: number;
  latestUpdatedAt: string;
  samples: DashboardFocusDigestSample[];
}

export interface DashboardAttentionSnapshot {
  generatedAt: string;
  inboxTotal: number;
  digests: DashboardFocusDigest[];
}

export interface DashboardInboxPage {
  cards: FeedCard[];
  total: number;
  nextOffset: number | null;
}

export interface DashboardDigestPage {
  cards: FeedCard[];
  total: number;
  nextOffset: number | null;
}

export interface DashboardClearedPage {
  cards: FeedCard[];
  total: number;
  nextOffset: number | null;
}

export interface FeedChecklistPromotionResult {
  created: boolean;
  card: FeedCard;
  checklistItem: ChecklistItem;
}

export interface FeedCardMutationInput {
  key?: unknown;
  dedupeKey?: unknown;
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  priority?: unknown;
  status?: unknown;
  taskId?: unknown;
  sessionId?: unknown;
  url?: unknown;
  links?: unknown;
  metadata?: unknown;
  action?: unknown;
  pinned?: unknown;
}

export interface FeedCardSaveResult {
  card: FeedCard;
  created: boolean;
}

export interface FeedCardMutationOptions {
  createId?: string;
  visual?: FeedCardVisual | null;
}

export interface FeedStoreOptions {
  mutations: FocusMutationCoordinator;
  checklistStore: ChecklistStore;
}

export class FeedCardValidationError extends Error {}
export class FeedCardNotFoundError extends Error {}
export class FeedCardPromotionError extends Error {}

const DEFAULT_KIND = "note";
const DEFAULT_PRIORITY: FeedCardPriority = "normal";
const DEFAULT_STATUS: FeedCardStatus = "active";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_LINKS = 20;
const STATS_DAY_MS = 86_400_000;
const DEFAULT_STATS_DAYS = 30;
const MAX_STATS_DAYS = 365;
const DEFAULT_STATS_BUCKETS = 14;
const MAX_STATS_BUCKETS = 60;
const FEED_CURSOR_VERSION = 1;
const DASHBOARD_INBOX_LIMIT = 20;
const DASHBOARD_INBOX_MAX_LIMIT = 50;
const DASHBOARD_DIGEST_SAMPLE_LIMIT = 3;
const DASHBOARD_INBOX_PREDICATE = `(
  feed_cards.kind = 'alert'
  OR (
    feed_cards.kind = 'decision'
    AND (
      feed_cards.taskId IS NULL
      OR (tasks.status = 'active' AND tasks.muted = 0)
    )
  )
)`;
const FEED_SUMMARY_COLUMNS = [
  "id",
  "dedupeKey",
  "title",
  "kind",
  "status",
  "priority",
  "taskId",
  "updatedAt",
  "pinned",
  "statusChangedAt",
  "createdAt",
].join(", ");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeFeedCreateId(value: string | undefined): string {
  if (value === undefined) return crypto.randomUUID();
  if (!UUID_RE.test(value)) throw new FeedCardValidationError("createId must be a valid UUID");
  return value;
}

const FIELD_LIMITS = {
  dedupeKey: 200,
  title: 240,
  body: 8 * 1024,
  kind: 40,
  taskId: 160,
  sessionId: 160,
  keyPrefix: 200,
  url: 2 * 1024,
  linksJson: 4 * 1024,
  metadataJson: 4 * 1024,
  visualJson: 4 * 1024,
  actionJson: 12 * 1024,
  actionLabel: 80,
  actionPrompt: 8 * 1024,
} as const;

const MUTATION_FIELDS = new Set([
  "key",
  "dedupeKey",
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
  "pinned",
]);

const IDENTITY_MUTATION_FIELDS = ["key", "dedupeKey"] as const;

export type MutableFeedCardField =
  | "title"
  | "body"
  | "kind"
  | "priority"
  | "status"
  | "taskId"
  | "sessionId"
  | "url"
  | "linksJson"
  | "metadataJson"
  | "visualJson"
  | "actionJson"
  | "pinned";

export type NormalizedFeedCreateFields = {
  dedupeKey: string | null;
  title: string;
  body: string | null;
  kind: string;
  priority: FeedCardPriority;
  status: FeedCardStatus;
  taskId: string | null;
  sessionId: string | null;
  url: string | null;
  linksJson: string;
  metadataJson: string | null;
  visualJson: string | null;
  actionJson: string | null;
  pinned: boolean;
};

export type NormalizedFeedUpdateFields = Partial<Record<MutableFeedCardField, string | number | null>>;

type FeedListOrder = "active" | "resolved" | "mixed";

interface NormalizedFeedListFilters {
  statusFilter: FeedCardStatus | undefined;
  includeDismissed: boolean;
  kind: string | undefined;
  taskId: string | undefined;
  sessionId: string | undefined;
  keyPrefix: string | undefined;
  limit: number;
  order: FeedListOrder;
}

interface FeedCursorPayload {
  v: typeof FEED_CURSOR_VERSION;
  order: FeedListOrder;
  status: FeedCardStatus | null;
  includeDismissed: boolean;
  kind: string | null;
  taskId: string | null;
  sessionId: string | null;
  keyPrefix: string | null;
  pinned: 0 | 1;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
  id: string;
}

interface FeedCursorPosition {
  pinned: boolean;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
  id: string;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertByteLimit(field: keyof typeof FIELD_LIMITS, value: string): void {
  const limit = FIELD_LIMITS[field];
  if (byteLength(value) > limit) {
    throw new FeedCardValidationError(`${field} must be ${limit} bytes or less`);
  }
}

function assertKnownMutationFields(input: FeedCardMutationInput): void {
  const unknown = Object.keys(input as Record<string, unknown>).filter((field) => !MUTATION_FIELDS.has(field));
  if (unknown.length > 0) {
    throw new FeedCardValidationError(`Unknown feed card field(s): ${unknown.join(", ")}`);
  }
}

function assertNoIdentityFieldUpdates(input: FeedCardMutationInput): void {
  const record = input as Record<string, unknown>;
  const attempted = IDENTITY_MUTATION_FIELDS.filter((field) => hasOwn(record, field));
  if (attempted.length > 0) {
    throw new FeedCardValidationError(
      `Feed card key fields cannot be updated (${attempted.join(", ")}); use POST /api/feed for keyed upserts`,
    );
  }
}

function assertSafeUrl(field: string, value: string): void {
  if (value.startsWith("/")) {
    if (value.startsWith("//")) throw new FeedCardValidationError(`${field} must be http, https, mailto, or root-relative`);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FeedCardValidationError(`${field} must be http, https, mailto, or root-relative`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    throw new FeedCardValidationError(`${field} must be http, https, mailto, or root-relative`);
  }
}

function normalizeString(
  field: keyof typeof FIELD_LIMITS,
  value: unknown,
  opts: { required?: boolean; nullable?: boolean; defaultValue?: string } = {},
): string | null | undefined {
  if (value === undefined) {
    if (opts.required) throw new FeedCardValidationError(`${field} is required`);
    return opts.defaultValue;
  }
  if (value === null) {
    if (opts.nullable) return null;
    if (opts.required) throw new FeedCardValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new FeedCardValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (opts.required) throw new FeedCardValidationError(`${field} is required`);
    if (opts.nullable) return null;
    return opts.defaultValue;
  }
  assertByteLimit(field, trimmed);
  return trimmed;
}

function normalizeRequiredTitle(value: unknown): string {
  return normalizeString("title", value, { required: true })!;
}

function normalizeOptionalNullableString(
  field: keyof typeof FIELD_LIMITS,
  value: unknown,
): string | null {
  return normalizeString(field, value, { nullable: true }) ?? null;
}

function normalizeOptionalUrl(field: "url", value: unknown): string | null {
  const normalized = normalizeOptionalNullableString(field, value);
  if (normalized !== null) assertSafeUrl(field, normalized);
  return normalized;
}

export function normalizeFeedDedupeKey(input: FeedCardMutationInput): string | null {
  const raw = hasOwn(input as Record<string, unknown>, "key") ? input.key : input.dedupeKey;
  return normalizeString("dedupeKey", raw, { nullable: true }) ?? null;
}

function normalizeKind(value: unknown): string {
  return normalizeString("kind", value, { defaultValue: DEFAULT_KIND }) ?? DEFAULT_KIND;
}

function normalizeStatus(value: unknown, defaultValue = DEFAULT_STATUS): FeedCardStatus {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === "active" || value === "done" || value === "dismissed") return value;
  throw new FeedCardValidationError("status must be one of: active, done, dismissed");
}

function normalizePriority(value: unknown, defaultValue = DEFAULT_PRIORITY): FeedCardPriority {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === "low" || value === "normal" || value === "high") return value;
  throw new FeedCardValidationError("priority must be one of: low, normal, high");
}

function normalizePinned(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  throw new FeedCardValidationError("pinned must be a boolean");
}

function normalizeLinks(value: unknown): string {
  if (value === undefined || value === null) return "[]";
  if (!Array.isArray(value)) throw new FeedCardValidationError("links must be an array");
  if (value.length > MAX_LINKS) throw new FeedCardValidationError(`links cannot contain more than ${MAX_LINKS} entries`);

  const links = value.map((entry, index): FeedCardLink => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new FeedCardValidationError(`links[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const label = normalizeString("title", record.label, { required: true });
    const url = normalizeString("url", record.url, { required: true });
    assertSafeUrl(`links[${index}].url`, url!);
    return { label: label!, url: url! };
  });
  const json = JSON.stringify(links);
  assertByteLimit("linksJson", json);
  return json;
}

function normalizeMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FeedCardValidationError("metadata must be an object");
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new FeedCardValidationError(`metadata must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertByteLimit("metadataJson", json);
  return json;
}

function normalizeActionLabel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new FeedCardValidationError("action.label must be a string");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new FeedCardValidationError("action.label cannot contain control characters");
  }
  assertByteLimit("actionLabel", trimmed);
  return trimmed;
}

function normalizeActionPrompt(value: unknown): string {
  if (typeof value !== "string") throw new FeedCardValidationError("action.prompt is required");
  const trimmed = value.trim();
  if (!trimmed) throw new FeedCardValidationError("action.prompt is required");
  assertByteLimit("actionPrompt", trimmed);
  return trimmed;
}

function normalizeActionTaskId(record: Record<string, unknown>, action: FeedCardAction): void {
  if (!hasOwn(record, "taskId")) return;
  action.taskId = normalizeOptionalNullableString("taskId", record.taskId);
}

function normalizeAction(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FeedCardValidationError("action must be an object or null");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((field) => field !== "label" && field !== "prompt" && field !== "taskId");
  if (unknown.length > 0) {
    throw new FeedCardValidationError(`Unknown action field(s): ${unknown.join(", ")}`);
  }
  const action: FeedCardAction = {
    prompt: normalizeActionPrompt(record.prompt),
  };
  const label = normalizeActionLabel(record.label);
  if (label) action.label = label;
  normalizeActionTaskId(record, action);

  const json = JSON.stringify(action);
  assertByteLimit("actionJson", json);
  return json;
}

function normalizeVisualKind(value: unknown): FeedCardVisual["kind"] {
  if (value === "image" || value === "mermaid" || value === "vega-lite" || value === "html") return value;
  throw new FeedCardValidationError("visual.kind must be one of: image, mermaid, vega-lite, html");
}

function normalizeVisualString(field: keyof typeof FIELD_LIMITS | "artifactId" | "displayName" | "mimeType", value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FeedCardValidationError(`visual.${field} is required`);
  }
  const trimmed = value.trim();
  const limitedField = field === "displayName" || field === "mimeType" || field === "artifactId" ? "title" : field;
  assertByteLimit(limitedField as keyof typeof FIELD_LIMITS, trimmed);
  return trimmed;
}

function assertExpectedFeedVisualUrl(field: string, value: string, cardId: string | undefined, artifactId: string, suffix: string): void {
  if (!cardId) return;
  let parsed: URL;
  try {
    parsed = new URL(value, "http://bridge.local");
  } catch {
    throw new FeedCardValidationError(`visual.${field} must be a feed-owned visual URL`);
  }
  const expectedPath = `/api/feed/${encodeURIComponent(cardId)}/visuals/${encodeURIComponent(artifactId)}${suffix}`;
  if (parsed.origin !== "http://bridge.local" || parsed.search || parsed.hash || !parsed.pathname.endsWith(expectedPath)) {
    throw new FeedCardValidationError(`visual.${field} must be a feed-owned visual URL`);
  }
}

export function normalizeTrustedFeedVisual(value: FeedCardVisual | null, cardId?: string): string | null {
  if (value === null) return null;
  const visual: FeedCardVisual = {
    artifactId: normalizeVisualString("artifactId", value.artifactId),
    kind: normalizeVisualKind(value.kind),
    title: normalizeVisualString("title", value.title),
    displayName: normalizeVisualString("displayName", value.displayName),
    mimeType: normalizeVisualString("mimeType", value.mimeType),
    size: value.size,
    url: normalizeVisualString("url", value.url),
    downloadUrl: normalizeVisualString("url", value.downloadUrl),
    ...(typeof value.caption === "string" && value.caption.trim() ? { caption: value.caption.trim() } : {}),
    ...(typeof value.altText === "string" && value.altText.trim() ? { altText: value.altText.trim() } : {}),
  };
  if (!UUID_RE.test(visual.artifactId)) throw new FeedCardValidationError("visual.artifactId must be a valid UUID");
  if (!Number.isInteger(visual.size) || visual.size < 0) {
    throw new FeedCardValidationError("visual.size must be a non-negative integer");
  }
  assertSafeUrl("visual.url", visual.url);
  assertSafeUrl("visual.downloadUrl", visual.downloadUrl);
  assertExpectedFeedVisualUrl("url", visual.url, cardId, visual.artifactId, "");
  assertExpectedFeedVisualUrl("downloadUrl", visual.downloadUrl, cardId, visual.artifactId, "/download");
  const json = JSON.stringify(visual);
  assertByteLimit("visualJson", json);
  return json;
}

function parseLinksJson(value: string): FeedCardLink[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored feed card links are invalid");
  return parsed.map((entry, index): FeedCardLink => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Stored feed card link ${index} is invalid`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.url !== "string") {
      throw new Error(`Stored feed card link ${index} is invalid`);
    }
    return { label: record.label, url: record.url };
  });
}

function parseMetadataJson(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored feed card metadata is invalid");
  }
  return parsed as Record<string, unknown>;
}

function parseVisualJson(value: string | null): FeedCardVisual | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored feed card visual is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const visual = {
    artifactId: normalizeVisualString("artifactId", record.artifactId),
    kind: normalizeVisualKind(record.kind),
    title: normalizeVisualString("title", record.title),
    displayName: normalizeVisualString("displayName", record.displayName),
    mimeType: normalizeVisualString("mimeType", record.mimeType),
    size: typeof record.size === "number" ? record.size : 0,
    url: normalizeVisualString("url", record.url),
    downloadUrl: normalizeVisualString("url", record.downloadUrl),
    ...(typeof record.caption === "string" && record.caption.trim() ? { caption: record.caption.trim() } : {}),
    ...(typeof record.altText === "string" && record.altText.trim() ? { altText: record.altText.trim() } : {}),
  };
  if (!UUID_RE.test(visual.artifactId)) throw new Error("Stored feed card visual is invalid");
  if (!Number.isInteger(visual.size) || visual.size < 0) throw new Error("Stored feed card visual is invalid");
  assertSafeUrl("visual.url", visual.url);
  assertSafeUrl("visual.downloadUrl", visual.downloadUrl);
  return visual;
}

function parseActionJson(value: string | null): FeedCardAction | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored feed card action is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const action: FeedCardAction = {
    prompt: normalizeActionPrompt(record.prompt),
  };
  const label = normalizeActionLabel(record.label);
  if (label) action.label = label;
  normalizeActionTaskId(record, action);
  return action;
}

export function hydrateFeedCardRow(row: any): FeedCard {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey ?? null,
    title: row.title,
    body: row.body ?? null,
    kind: row.kind,
    priority: normalizePriority(row.priority),
    status: normalizeStatus(row.status),
    taskId: row.taskId ?? null,
    sessionId: row.sessionId ?? null,
    url: row.url ?? null,
    links: parseLinksJson(row.linksJson),
    metadata: parseMetadataJson(row.metadataJson ?? null),
    visual: parseVisualJson(row.visualJson ?? null),
    action: parseActionJson(row.actionJson ?? null),
    pinned: row.pinned === 1,
    statusChangedAt: row.statusChangedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function hydrateFeedCardSummaryRow(row: any): FeedCardSummary {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey ?? null,
    title: row.title,
    kind: row.kind,
    status: normalizeStatus(row.status),
    priority: normalizePriority(row.priority),
    taskId: row.taskId ?? null,
    updatedAt: row.updatedAt,
  };
}

export function normalizeFeedCreateInput(input: FeedCardMutationInput): NormalizedFeedCreateFields {
  assertKnownMutationFields(input);
  return {
    dedupeKey: normalizeFeedDedupeKey(input),
    title: normalizeRequiredTitle(input.title),
    body: normalizeOptionalNullableString("body", input.body),
    kind: normalizeKind(input.kind),
    priority: normalizePriority(input.priority),
    status: normalizeStatus(input.status),
    taskId: normalizeOptionalNullableString("taskId", input.taskId),
    sessionId: normalizeOptionalNullableString("sessionId", input.sessionId),
    url: normalizeOptionalUrl("url", input.url),
    linksJson: normalizeLinks(input.links),
    metadataJson: normalizeMetadata(input.metadata),
    visualJson: null,
    actionJson: normalizeAction(input.action),
    pinned: normalizePinned(input.pinned),
  };
}

export function normalizeFeedUpdateInput(
  input: FeedCardMutationInput,
  options: { allowIdentityFields?: boolean } = {},
): NormalizedFeedUpdateFields {
  assertKnownMutationFields(input);
  if (!options.allowIdentityFields) assertNoIdentityFieldUpdates(input);
  const normalized: NormalizedFeedUpdateFields = {};
  const record = input as Record<string, unknown>;
  if (hasOwn(record, "title")) normalized.title = normalizeRequiredTitle(input.title);
  if (hasOwn(record, "body")) normalized.body = normalizeOptionalNullableString("body", input.body);
  if (hasOwn(record, "kind")) normalized.kind = normalizeKind(input.kind);
  if (hasOwn(record, "priority")) normalized.priority = normalizePriority(input.priority);
  if (hasOwn(record, "status")) normalized.status = normalizeStatus(input.status);
  if (hasOwn(record, "taskId")) normalized.taskId = normalizeOptionalNullableString("taskId", input.taskId);
  if (hasOwn(record, "sessionId")) normalized.sessionId = normalizeOptionalNullableString("sessionId", input.sessionId);
  if (hasOwn(record, "url")) normalized.url = normalizeOptionalUrl("url", input.url);
  if (hasOwn(record, "links")) normalized.linksJson = normalizeLinks(input.links);
  if (hasOwn(record, "metadata")) normalized.metadataJson = normalizeMetadata(input.metadata);
  if (hasOwn(record, "action")) normalized.actionJson = normalizeAction(input.action);
  if (hasOwn(record, "pinned")) normalized.pinned = normalizePinned(input.pinned) ? 1 : 0;
  return normalized;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new FeedCardValidationError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

function normalizeFilterString(field: keyof typeof FIELD_LIMITS, value: unknown): string | undefined {
  const normalized = normalizeString(field, value);
  return normalized ?? undefined;
}

function clampStatsInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function feedListOrder(status: FeedCardStatus | undefined): FeedListOrder {
  if (status === "done" || status === "dismissed") return "resolved";
  if (status === "active") return "active";
  return "mixed";
}

function feedPageOrderBy(order: FeedListOrder): string {
  switch (order) {
    case "active":
      return "pinned DESC, createdAt DESC, id DESC";
    case "resolved":
      return "statusChangedAt DESC, updatedAt DESC, id DESC";
    case "mixed":
      return "CASE WHEN status = 'active' THEN 0 ELSE 1 END, pinned DESC, updatedAt DESC, id DESC";
  }
}

function normalizeListFilters(filters: FeedCardPageFilters): NormalizedFeedListFilters {
  let statusFilter: FeedCardStatus | undefined;
  if (filters.status !== undefined) {
    statusFilter = normalizeStatus(filters.status);
  } else if (!filters.includeDismissed) {
    statusFilter = DEFAULT_STATUS;
  }
  return {
    statusFilter,
    includeDismissed: filters.includeDismissed === true,
    kind: normalizeFilterString("kind", filters.kind),
    taskId: normalizeFilterString("taskId", filters.taskId),
    sessionId: normalizeFilterString("sessionId", filters.sessionId),
    keyPrefix: normalizeFilterString("keyPrefix", filters.keyPrefix),
    limit: normalizeLimit(filters.limit),
    order: feedListOrder(statusFilter),
  };
}

function appendFeedListFilters(
  where: string[],
  values: Array<string | number>,
  filters: NormalizedFeedListFilters,
): void {
  if (filters.statusFilter !== undefined) {
    where.push("status = ?");
    values.push(filters.statusFilter);
  }
  if (filters.kind) {
    where.push("kind = ?");
    values.push(filters.kind);
  }
  if (filters.taskId) {
    where.push("taskId = ?");
    values.push(filters.taskId);
  }
  if (filters.sessionId) {
    where.push("sessionId = ?");
    values.push(filters.sessionId);
  }
  if (filters.keyPrefix) {
    where.push("instr(dedupeKey, ?) = 1");
    values.push(filters.keyPrefix);
  }
}

function cursorStringField(payload: Record<string, unknown>, field: keyof FeedCursorPayload): string {
  const value = payload[field];
  if (typeof value !== "string" || !value) {
    throw new FeedCardValidationError("cursor is invalid");
  }
  return value;
}

function cursorNullableStringField(payload: Record<string, unknown>, field: keyof FeedCursorPayload): string | null {
  const value = payload[field];
  if (value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new FeedCardValidationError("cursor is invalid");
  }
  return value;
}

function cursorOptionalNullableStringField(payload: Record<string, unknown>, field: keyof FeedCursorPayload): string | null {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new FeedCardValidationError("cursor is invalid");
  }
  return value;
}

function cursorStatusField(value: unknown): FeedCardStatus | null {
  if (value === null) return null;
  if (value === "active" || value === "done" || value === "dismissed") return value;
  throw new FeedCardValidationError("cursor is invalid");
}

function cursorOrderField(value: unknown): FeedListOrder {
  if (value === "active" || value === "resolved" || value === "mixed") return value;
  throw new FeedCardValidationError("cursor is invalid");
}

function decodeFeedCursor(cursor: string): FeedCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new FeedCardValidationError("cursor is invalid");
  }
  if (!isRecord(parsed) || parsed.v !== FEED_CURSOR_VERSION) {
    throw new FeedCardValidationError("cursor is invalid");
  }
  const pinned = parsed.pinned;
  if (pinned !== 0 && pinned !== 1) throw new FeedCardValidationError("cursor is invalid");
  if (typeof parsed.includeDismissed !== "boolean") throw new FeedCardValidationError("cursor is invalid");
  return {
    v: FEED_CURSOR_VERSION,
    order: cursorOrderField(parsed.order),
    status: cursorStatusField(parsed.status),
    includeDismissed: parsed.includeDismissed,
    kind: cursorNullableStringField(parsed, "kind"),
    taskId: cursorNullableStringField(parsed, "taskId"),
    sessionId: cursorNullableStringField(parsed, "sessionId"),
    keyPrefix: cursorOptionalNullableStringField(parsed, "keyPrefix"),
    pinned,
    statusChangedAt: cursorStringField(parsed, "statusChangedAt"),
    createdAt: cursorStringField(parsed, "createdAt"),
    updatedAt: cursorStringField(parsed, "updatedAt"),
    id: cursorStringField(parsed, "id"),
  };
}

function assertFeedCursorScope(cursor: FeedCursorPayload, filters: NormalizedFeedListFilters): void {
  if (
    cursor.order !== filters.order
    || cursor.status !== (filters.statusFilter ?? null)
    || cursor.includeDismissed !== filters.includeDismissed
    || cursor.kind !== (filters.kind ?? null)
    || cursor.taskId !== (filters.taskId ?? null)
    || cursor.sessionId !== (filters.sessionId ?? null)
    || cursor.keyPrefix !== (filters.keyPrefix ?? null)
  ) {
    throw new FeedCardValidationError("cursor does not match feed filters");
  }
}

function encodeFeedCursor(position: FeedCursorPosition, filters: NormalizedFeedListFilters): string {
  const payload: FeedCursorPayload = {
    v: FEED_CURSOR_VERSION,
    order: filters.order,
    status: filters.statusFilter ?? null,
    includeDismissed: filters.includeDismissed,
    kind: filters.kind ?? null,
    taskId: filters.taskId ?? null,
    sessionId: filters.sessionId ?? null,
    keyPrefix: filters.keyPrefix ?? null,
    pinned: position.pinned ? 1 : 0,
    statusChangedAt: position.statusChangedAt,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
    id: position.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function cursorPositionFromRow(row: any): FeedCursorPosition {
  return {
    pinned: row.pinned === 1,
    statusChangedAt: row.statusChangedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    id: row.id,
  };
}

function appendCursorPredicate(
  where: string[],
  values: Array<string | number>,
  cursor: FeedCursorPayload,
): void {
  switch (cursor.order) {
    case "active":
      where.push("(pinned < ? OR (pinned = ? AND createdAt < ?) OR (pinned = ? AND createdAt = ? AND id < ?))");
      values.push(cursor.pinned, cursor.pinned, cursor.createdAt, cursor.pinned, cursor.createdAt, cursor.id);
      return;
    case "resolved":
      where.push(
        "(statusChangedAt < ? OR (statusChangedAt = ? AND updatedAt < ?) OR (statusChangedAt = ? AND updatedAt = ? AND id < ?))",
      );
      values.push(
        cursor.statusChangedAt,
        cursor.statusChangedAt,
        cursor.updatedAt,
        cursor.statusChangedAt,
        cursor.updatedAt,
        cursor.id,
      );
      return;
    case "mixed":
      throw new FeedCardValidationError("cursor pagination requires a status when includeDismissed is true");
  }
}

export function createFeedStore(db: DatabaseSync, options: FeedStoreOptions) {
  function getCard(id: string): FeedCard | undefined {
    const row = db.prepare("SELECT * FROM feed_cards WHERE id = ?").get(id) as any;
    return row ? hydrateFeedCardRow(row) : undefined;
  }

  function getCardByKey(dedupeKey: string): FeedCard | undefined {
    const key = normalizeString("dedupeKey", dedupeKey, { required: true })!;
    const row = db.prepare("SELECT * FROM feed_cards WHERE dedupeKey = ?").get(key) as any;
    return row ? hydrateFeedCardRow(row) : undefined;
  }

  function saveCard(input: FeedCardMutationInput, mutationOptions: FeedCardMutationOptions = {}): FeedCardSaveResult {
    return options.mutations.saveLegacy(input, mutationOptions);
  }

  function updateCardById(id: string, input: FeedCardMutationInput, mutationOptions: FeedCardMutationOptions = {}): FeedCard {
    return options.mutations.updateLegacyById(id, input, mutationOptions);
  }

  function updateCardByKey(dedupeKey: string, input: FeedCardMutationInput, mutationOptions: FeedCardMutationOptions = {}): FeedCard {
    return options.mutations.updateLegacyByKey(dedupeKey, input, mutationOptions);
  }

  function deleteCardById(id: string): boolean {
    return options.mutations.deleteById(id);
  }

  function deleteCardByKey(dedupeKey: string): boolean {
    return options.mutations.deleteByKey(dedupeKey);
  }

  function getKindStats(statsOptions: FeedKindStatsOptions = {}): FeedKindStats {
    const days = clampStatsInt(statsOptions.days, DEFAULT_STATS_DAYS, 1, MAX_STATS_DAYS);
    const buckets = clampStatsInt(statsOptions.buckets, DEFAULT_STATS_BUCKETS, 1, MAX_STATS_BUCKETS);
    const windowEndMs = Number.isFinite(statsOptions.now) ? (statsOptions.now as number) : Date.now();
    const windowMs = days * STATS_DAY_MS;
    const windowStartMs = windowEndMs - windowMs;
    const bucketWidthMs = windowMs / buckets;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const windowEndIso = new Date(windowEndMs).toISOString();

    const keyPrefix = typeof statsOptions.keyPrefix === "string" && statsOptions.keyPrefix.length > 0
      ? statsOptions.keyPrefix
      : undefined;

    const totalsRows = db.prepare(`
      SELECT kind,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
        MAX(updatedAt) AS lastActivityAt
      FROM feed_cards${keyPrefix ? " WHERE instr(dedupeKey, ?) = 1" : ""}
      GROUP BY kind
    `).all(...(keyPrefix ? [keyPrefix] : [])) as any[];

    const activityRows = db.prepare(`
      SELECT kind, updatedAt FROM feed_cards
      WHERE updatedAt >= ? AND updatedAt <= ?${keyPrefix ? " AND instr(dedupeKey, ?) = 1" : ""}
    `).all(...(keyPrefix ? [windowStartIso, windowEndIso, keyPrefix] : [windowStartIso, windowEndIso])) as any[];

    const statByKind = new Map<string, FeedKindStat>();
    for (const row of totalsRows) {
      statByKind.set(row.kind, {
        kind: row.kind,
        total: Number(row.total) || 0,
        active: Number(row.active) || 0,
        done: Number(row.done) || 0,
        dismissed: Number(row.dismissed) || 0,
        lastActivityAt: row.lastActivityAt ?? null,
        buckets: new Array<number>(buckets).fill(0),
      });
    }

    const aggregateBuckets = new Array<number>(buckets).fill(0);
    for (const row of activityRows) {
      const stat = statByKind.get(row.kind);
      if (!stat) continue;
      const t = Date.parse(row.updatedAt);
      if (!Number.isFinite(t)) continue;
      let idx = Math.floor((t - windowStartMs) / bucketWidthMs);
      if (idx === buckets) idx = buckets - 1;
      if (idx < 0 || idx >= buckets) continue;
      stat.buckets[idx] += 1;
      aggregateBuckets[idx] += 1;
    }

    const kinds = [...statByKind.values()].sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.kind.localeCompare(b.kind);
    });

    let total = 0;
    let active = 0;
    for (const stat of kinds) {
      total += stat.total;
      active += stat.active;
    }

    return {
      generatedAt: windowEndIso,
      windowDays: days,
      bucketCount: buckets,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      total,
      active,
      buckets: aggregateBuckets,
      kinds,
    };
  }

  function getDashboardAttention(): DashboardAttentionSnapshot {
    const inboxTotalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feed_cards
      LEFT JOIN tasks ON tasks.id = feed_cards.taskId
      WHERE feed_cards.status = 'active'
        AND ${DASHBOARD_INBOX_PREDICATE}
    `).get() as { count?: number };
    const rows = db.prepare(`
      SELECT feed_cards.*,
        tasks.title AS relatedTaskTitle,
        tasks.muted AS relatedTaskMuted,
        tasks.status AS relatedTaskStatus
      FROM feed_cards
      LEFT JOIN tasks ON tasks.id = feed_cards.taskId
      WHERE feed_cards.status = 'active'
        AND NOT ${DASHBOARD_INBOX_PREDICATE}
      ORDER BY
        feed_cards.pinned DESC,
        CASE feed_cards.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        feed_cards.updatedAt DESC,
        feed_cards.id DESC
    `).all() as any[];
    const cards = hydrateRowsSafely(rows, hydrateFeedCardRow, FEED_CARD_HYDRATION);
    const rowById = new Map(rows.map((row) => [String(row.id), row]));
    const digestById = new Map<string, DashboardFocusDigest>();

    for (const card of cards) {
      const row = rowById.get(card.id);
      const dedupeKey = card.dedupeKey?.trim() ?? "";
      const separatorIndex = dedupeKey.indexOf(":");
      const family = dedupeKey
        ? (separatorIndex > 0 ? dedupeKey.slice(0, separatorIndex) : dedupeKey)
        : card.kind;
      const keyPrefix = dedupeKey
        ? (separatorIndex > 0 ? `${family}:` : dedupeKey)
        : null;
      const kind = dedupeKey ? null : card.kind;
      const taskKey = card.taskId ?? "__global__";
      const sourceKey = keyPrefix ?? `kind:${kind}`;
      const id = `${taskKey}\u0000${sourceKey}`;
      let digest = digestById.get(id);
      if (!digest) {
        digest = {
          id,
          family,
          keyPrefix,
          kind,
          taskId: card.taskId,
          taskTitle: typeof row?.relatedTaskTitle === "string" ? row.relatedTaskTitle : null,
          quiet: row?.relatedTaskMuted === 1 || row?.relatedTaskStatus === "archived",
          count: 0,
          highPriorityCount: 0,
          latestUpdatedAt: card.updatedAt,
          samples: [],
        };
        digestById.set(id, digest);
      }
      digest.count += 1;
      if (card.priority === "high") digest.highPriorityCount += 1;
      if (card.updatedAt > digest.latestUpdatedAt) digest.latestUpdatedAt = card.updatedAt;
      if (digest.samples.length < DASHBOARD_DIGEST_SAMPLE_LIMIT) {
        digest.samples.push({
          id: card.id,
          title: card.title,
          kind: card.kind,
          priority: card.priority,
          updatedAt: card.updatedAt,
        });
      }
    }

    const digests = [...digestById.values()].sort((left, right) => {
      if (left.quiet !== right.quiet) return left.quiet ? 1 : -1;
      const latestCompare = right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
      if (latestCompare !== 0) return latestCompare;
      if (right.count !== left.count) return right.count - left.count;
      return left.id.localeCompare(right.id);
    });

    return {
      generatedAt: new Date().toISOString(),
      inboxTotal: Number(inboxTotalRow.count) || 0,
      digests,
    };
  }

  function listDashboardInbox(
    options: { offset?: number; limit?: number } = {},
  ): DashboardInboxPage {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? DASHBOARD_INBOX_LIMIT;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FeedCardValidationError("offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > DASHBOARD_INBOX_MAX_LIMIT) {
      throw new FeedCardValidationError(`limit must be an integer from 1 to ${DASHBOARD_INBOX_MAX_LIMIT}`);
    }
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feed_cards
      LEFT JOIN tasks ON tasks.id = feed_cards.taskId
      WHERE feed_cards.status = 'active'
        AND ${DASHBOARD_INBOX_PREDICATE}
    `).get() as { count?: number };
    const rows = db.prepare(`
      SELECT feed_cards.*
      FROM feed_cards
      LEFT JOIN tasks ON tasks.id = feed_cards.taskId
      WHERE feed_cards.status = 'active'
        AND ${DASHBOARD_INBOX_PREDICATE}
      ORDER BY
        feed_cards.pinned DESC,
        CASE feed_cards.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        feed_cards.updatedAt DESC,
        feed_cards.id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];
    const cards = hydrateRowsSafely(rows, hydrateFeedCardRow, FEED_CARD_HYDRATION);
    const total = Number(totalRow.count) || 0;
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    return { cards, total, nextOffset };
  }

  function listDashboardDigestItems(options: {
    taskId: string | null;
    keyPrefix?: string;
    kind?: string;
    offset?: number;
    limit?: number;
  }): DashboardDigestPage {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? DASHBOARD_INBOX_LIMIT;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FeedCardValidationError("offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > DASHBOARD_INBOX_MAX_LIMIT) {
      throw new FeedCardValidationError(`limit must be an integer from 1 to ${DASHBOARD_INBOX_MAX_LIMIT}`);
    }
    const keyPrefix = options.keyPrefix?.trim();
    const kind = options.kind?.trim();
    if (Boolean(keyPrefix) === Boolean(kind)) {
      throw new FeedCardValidationError("Provide exactly one of keyPrefix or kind");
    }

    const where = ["feed_cards.status = 'active'", `NOT ${DASHBOARD_INBOX_PREDICATE}`];
    const values: Array<string | number> = [];
    if (options.taskId === null) {
      where.push("feed_cards.taskId IS NULL");
    } else {
      where.push("feed_cards.taskId = ?");
      values.push(options.taskId);
    }
    if (keyPrefix) {
      where.push(keyPrefix.endsWith(":") ? "instr(feed_cards.dedupeKey, ?) = 1" : "feed_cards.dedupeKey = ?");
      values.push(keyPrefix);
    } else {
      where.push("feed_cards.dedupeKey IS NULL", "feed_cards.kind = ?");
      values.push(kind!);
    }
    const whereClause = where.join(" AND ");
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feed_cards
      LEFT JOIN tasks ON tasks.id = feed_cards.taskId
      WHERE ${whereClause}
    `)
      .get(...values) as { count?: number };
    const rows = db.prepare(`
      SELECT feed_cards.*
      FROM feed_cards
      LEFT JOIN tasks ON tasks.id = feed_cards.taskId
      WHERE ${whereClause}
      ORDER BY
        feed_cards.pinned DESC,
        CASE feed_cards.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        feed_cards.updatedAt DESC,
        feed_cards.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as any[];
    const cards = hydrateRowsSafely(rows, hydrateFeedCardRow, FEED_CARD_HYDRATION);
    const total = Number(totalRow.count) || 0;
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    return { cards, total, nextOffset };
  }

  function listDashboardCleared(
    options: { offset?: number; limit?: number } = {},
  ): DashboardClearedPage {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? DASHBOARD_INBOX_LIMIT;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FeedCardValidationError("offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > DASHBOARD_INBOX_MAX_LIMIT) {
      throw new FeedCardValidationError(`limit must be an integer from 1 to ${DASHBOARD_INBOX_MAX_LIMIT}`);
    }
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feed_cards
      WHERE status IN ('done', 'dismissed')
    `).get() as { count?: number };
    const rows = db.prepare(`
      SELECT *
      FROM feed_cards
      WHERE status IN ('done', 'dismissed')
      ORDER BY statusChangedAt DESC, updatedAt DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];
    const cards = hydrateRowsSafely(rows, hydrateFeedCardRow, FEED_CARD_HYDRATION);
    const total = Number(totalRow.count) || 0;
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    return { cards, total, nextOffset };
  }

  function promoteCardToChecklist(cardId: string, input: { text?: unknown; taskId?: unknown; expectedActivationId?: unknown } = {}): FeedChecklistPromotionResult {
    const result = options.mutations.promoteToAction(cardId, options.checklistStore, input);
    const card = getCard(result.object.id);
    if (!card) throw new FeedCardNotFoundError(`Feed card ${result.object.id} not found`);
    return {
      created: result.created,
      card,
      checklistItem: result.action,
    };
  }

  function listCardPage(filters: FeedCardMinimalPageFilters): FeedCardSummaryListPage;
  function listCardPage(filters?: FeedCardPageFilters): FeedCardListPage;
  function listCardPage(
    filters: FeedCardPageFilters & { minimal?: boolean } = {},
  ): FeedCardListPage | FeedCardSummaryListPage {
    const normalized = normalizeListFilters(filters);
    const where: string[] = [];
    const values: Array<string | number> = [];
    appendFeedListFilters(where, values, normalized);
    if (filters.cursor !== undefined && filters.cursor !== null && filters.cursor !== "") {
      if (typeof filters.cursor !== "string") throw new FeedCardValidationError("cursor must be a string");
      const cursor = decodeFeedCursor(filters.cursor);
      assertFeedCursorScope(cursor, normalized);
      appendCursorPredicate(where, values, cursor);
    }
    const minimal = filters.minimal === true;
    const pageLimit = normalized.limit + 1;
    values.push(pageLimit);
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT ${minimal ? FEED_SUMMARY_COLUMNS : "*"} FROM feed_cards
      ${whereClause}
      ORDER BY ${feedPageOrderBy(normalized.order)}
      LIMIT ?
    `).all(...values) as any[];
    const pageRows = rows.slice(0, normalized.limit);
    const hasMore = rows.length > normalized.limit;
    const lastRow = pageRows[pageRows.length - 1];
    // A card whose stored visual/action/metadata JSON no longer validates is
    // skipped rather than thrown, so one bad row cannot blank the whole feed.
    // Paging math stays keyed to the raw page window: the cursor still advances
    // past the skipped row, so pagination can neither stall nor skip good cards.
    const cards = minimal
      ? hydrateRowsSafely(pageRows, hydrateFeedCardSummaryRow, FEED_CARD_HYDRATION)
      : hydrateRowsSafely(pageRows, hydrateFeedCardRow, FEED_CARD_HYDRATION);
    const meta: FeedCardPageMeta = {
      nextCursor: normalized.order !== "mixed" && hasMore && lastRow
        ? encodeFeedCursor(cursorPositionFromRow(lastRow), normalized)
        : null,
      returnedCount: cards.length,
      hasMore,
    };
    return minimal
      ? { cards: cards as FeedCardSummary[], ...meta }
      : { cards: cards as FeedCard[], ...meta };
  }

  return {
    listCardPage,
    getKindStats,
    getDashboardAttention,
    listDashboardInbox,
    listDashboardDigestItems,
    listDashboardCleared,
    getCard,
    getCardByKey,
    saveCard,
    updateCardById,
    updateCardByKey,
    promoteCardToChecklist,
    deleteCardById,
    deleteCardByKey,
  };
}

export type FeedStore = ReturnType<typeof createFeedStore>;

import type { DatabaseSync } from "./db.js";
import type { GlobalBus } from "./global-bus.js";

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

export interface FeedCardListFilters {
  status?: FeedCardStatus;
  kind?: string;
  taskId?: string;
  sessionId?: string;
  includeDismissed?: boolean;
  limit?: number;
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
  onVisualUnreferenced?: (visual: FeedCardVisual, card: FeedCard) => void;
}

interface VisualCleanup {
  visual: FeedCardVisual;
  card: FeedCard;
}

export class FeedCardValidationError extends Error {}
export class FeedCardNotFoundError extends Error {}

const DEFAULT_KIND = "note";
const DEFAULT_PRIORITY: FeedCardPriority = "normal";
const DEFAULT_STATUS: FeedCardStatus = "active";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_LINKS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_LIMITS = {
  dedupeKey: 200,
  title: 240,
  body: 8 * 1024,
  kind: 40,
  taskId: 160,
  sessionId: 160,
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

type MutableFeedCardField =
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

type NormalizedCreateFields = {
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

type NormalizedUpdateFields = Partial<Record<MutableFeedCardField, string | number | null>>;

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

function normalizeDedupeKey(input: FeedCardMutationInput): string | null {
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

function normalizeTrustedVisual(value: FeedCardVisual | null, cardId?: string): string | null {
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

function normalizeCreateInput(input: FeedCardMutationInput): NormalizedCreateFields {
  assertKnownMutationFields(input);
  return {
    dedupeKey: normalizeDedupeKey(input),
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

function normalizeUpdateInput(
  input: FeedCardMutationInput,
  options: { allowIdentityFields?: boolean } = {},
): NormalizedUpdateFields {
  assertKnownMutationFields(input);
  if (!options.allowIdentityFields) assertNoIdentityFieldUpdates(input);
  const normalized: NormalizedUpdateFields = {};
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

export function createFeedStore(db: DatabaseSync, bus: GlobalBus, options: FeedStoreOptions = {}) {
  function hydrate(row: any): FeedCard {
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

  function emitChange(card: Pick<FeedCard, "id" | "dedupeKey" | "taskId" | "sessionId">): void {
    bus.emit({
      type: "feed:changed",
      cardId: card.id,
      dedupeKey: card.dedupeKey ?? undefined,
      taskId: card.taskId ?? undefined,
      sessionId: card.sessionId ?? undefined,
    });
  }

  function emitVisualUnreferenced(cleanup: VisualCleanup | undefined): void {
    if (cleanup) options.onVisualUnreferenced?.(cleanup.visual, cleanup.card);
  }

  function normalizeCreateId(value: string | undefined): string {
    if (value === undefined) return crypto.randomUUID();
    if (!UUID_RE.test(value)) throw new FeedCardValidationError("createId must be a valid UUID");
    return value;
  }

  function hasVisualOption(mutationOptions: FeedCardMutationOptions): boolean {
    return Object.prototype.hasOwnProperty.call(mutationOptions, "visual");
  }

  function getCard(id: string): FeedCard | undefined {
    const row = db.prepare("SELECT * FROM feed_cards WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function getCardByKey(dedupeKey: string): FeedCard | undefined {
    const key = normalizeString("dedupeKey", dedupeKey, { required: true })!;
    const row = db.prepare("SELECT * FROM feed_cards WHERE dedupeKey = ?").get(key) as any;
    return row ? hydrate(row) : undefined;
  }

  function insertCard(fields: NormalizedCreateFields, now = new Date().toISOString(), idOverride?: string): FeedCard {
    const id = normalizeCreateId(idOverride);
    db.prepare(`
      INSERT INTO feed_cards (
        id, dedupeKey, title, body, kind, priority, status, taskId, sessionId, url,
        linksJson, metadataJson, visualJson, actionJson, pinned, statusChangedAt, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fields.dedupeKey,
      fields.title,
      fields.body,
      fields.kind,
      fields.priority,
      fields.status,
      fields.taskId,
      fields.sessionId,
      fields.url,
      fields.linksJson,
      fields.metadataJson,
      fields.visualJson,
      fields.actionJson,
      fields.pinned ? 1 : 0,
      now,
      now,
      now,
    );
    return getCard(id)!;
  }

  function applyUpdate(
    existing: FeedCard,
    updates: NormalizedUpdateFields,
    mutationOptions: FeedCardMutationOptions = {},
    now = new Date().toISOString(),
  ): { card: FeedCard; cleanup?: VisualCleanup } {
    const entries = Object.entries(updates) as Array<[MutableFeedCardField, string | number | null]>;
    if (hasVisualOption(mutationOptions)) {
      entries.push(["visualJson", normalizeTrustedVisual(mutationOptions.visual ?? null, existing.id)]);
    }
    if (entries.length === 0) return { card: existing };

    const fields: string[] = ["updatedAt = ?"];
    const values: Array<string | number | null> = [now];
    for (const [field, value] of entries) {
      fields.push(`${field} = ?`);
      values.push(value);
    }
    if (updates.status !== undefined && updates.status !== existing.status) {
      fields.push("statusChangedAt = ?");
      values.push(now);
    }
    values.push(existing.id);
    db.prepare(`UPDATE feed_cards SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    const card = getCard(existing.id)!;
    const cleanup = hasVisualOption(mutationOptions)
      && existing.visual
      && existing.visual.artifactId !== mutationOptions.visual?.artifactId
      ? { visual: existing.visual, card: existing }
      : undefined;
    return { card, cleanup };
  }

  function saveCard(input: FeedCardMutationInput, mutationOptions: FeedCardMutationOptions = {}): FeedCardSaveResult {
    const dedupeKey = normalizeDedupeKey(input);
    const visualJson = hasVisualOption(mutationOptions)
      ? normalizeTrustedVisual(mutationOptions.visual ?? null, mutationOptions.createId)
      : null;
    if (!dedupeKey) {
      const card = insertCard({ ...normalizeCreateInput(input), visualJson }, undefined, mutationOptions.createId);
      emitChange(card);
      return { card, created: true };
    }

    let inTransaction = false;
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    try {
      const existing = getCardByKey(dedupeKey);
      if (existing) {
        const update = applyUpdate(existing, normalizeUpdateInput(input, { allowIdentityFields: true }), mutationOptions);
        db.exec("COMMIT");
        inTransaction = false;
        emitChange(update.card);
        emitVisualUnreferenced(update.cleanup);
        return { card: update.card, created: false };
      }
      const card = insertCard({ ...normalizeCreateInput(input), dedupeKey, visualJson }, undefined, mutationOptions.createId);
      db.exec("COMMIT");
      inTransaction = false;
      emitChange(card);
      return { card, created: true };
    } catch (error) {
      if (inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  function updateCardById(id: string, input: FeedCardMutationInput, mutationOptions: FeedCardMutationOptions = {}): FeedCard {
    const existing = getCard(id);
    if (!existing) throw new FeedCardNotFoundError(`Feed card ${id} not found`);
    const updates = normalizeUpdateInput(input);
    if (Object.keys(updates).length === 0 && !hasVisualOption(mutationOptions)) {
      throw new FeedCardValidationError("No fields to update");
    }
    const update = applyUpdate(existing, updates, mutationOptions);
    emitChange(update.card);
    emitVisualUnreferenced(update.cleanup);
    return update.card;
  }

  function updateCardByKey(dedupeKey: string, input: FeedCardMutationInput, mutationOptions: FeedCardMutationOptions = {}): FeedCard {
    const existing = getCardByKey(dedupeKey);
    if (!existing) throw new FeedCardNotFoundError(`Feed card with key ${dedupeKey} not found`);
    const updates = normalizeUpdateInput(input);
    if (Object.keys(updates).length === 0 && !hasVisualOption(mutationOptions)) {
      throw new FeedCardValidationError("No fields to update");
    }
    const update = applyUpdate(existing, updates, mutationOptions);
    emitChange(update.card);
    emitVisualUnreferenced(update.cleanup);
    return update.card;
  }

  function deleteCardById(id: string): boolean {
    const existing = getCard(id);
    if (!existing) return false;
    db.prepare("DELETE FROM feed_cards WHERE id = ?").run(id);
    emitChange(existing);
    emitVisualUnreferenced(existing.visual ? { visual: existing.visual, card: existing } : undefined);
    return true;
  }

  function deleteCardByKey(dedupeKey: string): boolean {
    const existing = getCardByKey(dedupeKey);
    if (!existing) return false;
    db.prepare("DELETE FROM feed_cards WHERE id = ?").run(existing.id);
    emitChange(existing);
    emitVisualUnreferenced(existing.visual ? { visual: existing.visual, card: existing } : undefined);
    return true;
  }

  function listCards(filters: FeedCardListFilters = {}): FeedCard[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filters.status !== undefined) {
      where.push("status = ?");
      values.push(normalizeStatus(filters.status));
    } else if (!filters.includeDismissed) {
      where.push("status = ?");
      values.push(DEFAULT_STATUS);
    }
    const kind = normalizeFilterString("kind", filters.kind);
    if (kind) {
      where.push("kind = ?");
      values.push(kind);
    }
    const taskId = normalizeFilterString("taskId", filters.taskId);
    if (taskId) {
      where.push("taskId = ?");
      values.push(taskId);
    }
    const sessionId = normalizeFilterString("sessionId", filters.sessionId);
    if (sessionId) {
      where.push("sessionId = ?");
      values.push(sessionId);
    }
    const limit = normalizeLimit(filters.limit);
    values.push(limit);
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return (db.prepare(`
      SELECT * FROM feed_cards
      ${whereClause}
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, pinned DESC, updatedAt DESC, id DESC
      LIMIT ?
    `).all(...values) as any[]).map(hydrate);
  }

  return {
    listCards,
    getCard,
    getCardByKey,
    saveCard,
    updateCardById,
    updateCardByKey,
    deleteCardById,
    deleteCardByKey,
  };
}

export type FeedStore = ReturnType<typeof createFeedStore>;

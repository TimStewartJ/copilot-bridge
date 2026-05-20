import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ── Types ─────────────────────────────────────────────────────────

export interface DocPage {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, any>;
  body: string;
  folder: string;
  isDbItem: boolean;
  isFolderIndex: boolean;
  created: string;
  modified: string;
}

export interface DocTreeNode {
  name: string;
  type: "file" | "folder";
  path: string;
  isDb?: boolean;
  hasIndex?: boolean;
  children?: DocTreeNode[];
}

export interface DbSchema {
  name: string;
  fields: DbField[];
}

export interface DbField {
  name: string;
  type: "text" | "select" | "date" | "number" | "boolean" | "url";
  options?: string[];
  required?: boolean;
}

export interface DbEntry {
  path: string;
  slug: string;
  title: string;
  fields: Record<string, any>;
  body: string;
  created: string;
  modified: string;
}

const VALID_FIELD_TYPES = new Set(["text", "select", "date", "number", "boolean", "url"]);
const DB_INPUT_RESERVED_KEYS = new Set(["folder", "slug", "body", "fields"]);
const DANGEROUS_DB_FIELD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SYSTEM_DB_FIELD_KEYS = new Set(["created", "modified"]);
const WINDOWS_RESERVED_PATH_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
export const TAGGED_DOC_DESCRIPTION_ERROR = "Tagged docs must include a non-empty frontmatter description";

export class DocsStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsStoreValidationError";
  }
}

export interface DocsPathApi {
  join: (...paths: string[]) => string;
  resolve: (...paths: string[]) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  sep: string;
}

const nativePathApi: DocsPathApi = { join, resolve, relative, isAbsolute, sep };

export function validateDocsPathSegments(input: string, label = "path"): string[] {
  const normalized = input.replace(/\\/g, "/").replace(/\.md$/i, "");
  if (!normalized || normalized.startsWith("/")) {
    throw new DocsStoreValidationError(`Invalid ${label}: must be a non-empty relative path`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new DocsStoreValidationError(`Invalid ${label}: path is empty`);
  }
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new DocsStoreValidationError(`Invalid ${label}: directory traversal ("${seg}") is not allowed`);
    }
    if (WINDOWS_RESERVED_PATH_CHARS.test(seg)) {
      throw new DocsStoreValidationError(`Invalid ${label}: Windows-reserved path characters are not allowed ("${seg}")`);
    }
    if (WINDOWS_RESERVED_DEVICE_NAME.test(seg)) {
      throw new DocsStoreValidationError(`Invalid ${label}: Windows reserved device name ("${seg}") is not allowed`);
    }
    if (seg.endsWith(" ") || seg.endsWith(".")) {
      throw new DocsStoreValidationError(`Invalid ${label}: Windows path segments cannot end with a space or dot ("${seg}")`);
    }
  }
  return segments;
}

export function isResolvedPathWithinRoot(root: string, candidate: string, pathApi: DocsPathApi = nativePathApi): boolean {
  const resolvedRoot = pathApi.resolve(root);
  const resolvedCandidate = pathApi.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;

  const relativePath = pathApi.relative(resolvedRoot, resolvedCandidate);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath);
}

export function resolveContainedDocsPath(
  root: string,
  segments: string[],
  leafSegments: string[] = [],
  label = "path",
  pathApi: DocsPathApi = nativePathApi,
): string {
  const resolvedRoot = pathApi.resolve(root);
  const candidate = pathApi.resolve(pathApi.join(resolvedRoot, ...segments, ...leafSegments));
  if (!isResolvedPathWithinRoot(resolvedRoot, candidate, pathApi)) {
    throw new DocsStoreValidationError(`Invalid ${label}: resolved path escapes docs root`);
  }
  return candidate;
}

export function resolveValidatedDocsPath(
  root: string,
  input: string,
  label = "path",
  pathApi: DocsPathApi = nativePathApi,
): string {
  return resolveContainedDocsPath(root, validateDocsPathSegments(input, label), [], label, pathApi);
}

export function normalizeDocsPublicPath(input: string): string {
  const segments = validateDocsPathSegments(input, "page path");
  if (segments.length > 1 && segments[segments.length - 1] === "index") {
    return segments.slice(0, -1).join("/");
  }
  return segments.join("/");
}

function getTaggedDocFrontmatterTags(frontmatter: { tags?: unknown }): string[] {
  if (Array.isArray(frontmatter.tags)) {
    return frontmatter.tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (typeof frontmatter.tags === "string") {
    const trimmed = frontmatter.tags.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

export function validateTaggedDocContent(content: string): void {
  const { data } = matter(content);
  const tags = getTaggedDocFrontmatterTags(data);
  if (tags.length === 0) return;
  if (typeof data.description !== "string" || !data.description.trim()) {
    throw new DocsStoreValidationError(TAGGED_DOC_DESCRIPTION_ERROR);
  }
}

// ── Factory ───────────────────────────────────────────────────────

export function createDocsStore(docsDir: string) {
  if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
  const docsRoot = realpathSync(docsDir);

  // ── Path helpers ──────────────────────────────────────────────

  interface ParsedPagePath {
    originalSegments: string[];
    canonicalPath: string;
    canonicalSegments: string[];
    isFolderIndexAlias: boolean;
  }

  function publicPathFromSegments(segments: string[]): string {
    return segments.join("/");
  }

  function parsePagePath(pagePath: string): ParsedPagePath {
    const segments = validateDocsPathSegments(pagePath, "page path");
    const isFolderIndexAlias = segments.length > 1 && segments[segments.length - 1] === "index";
    const canonicalSegments = isFolderIndexAlias ? segments.slice(0, -1) : segments;
    return {
      originalSegments: segments,
      canonicalPath: publicPathFromSegments(canonicalSegments),
      canonicalSegments,
      isFolderIndexAlias,
    };
  }

  function filePathForSegments(segments: string[]): string {
    const pageName = segments.at(-1);
    if (!pageName) throw new DocsStoreValidationError("Invalid page path: path is empty");
    return resolveContainedDocsPath(docsRoot, segments.slice(0, -1), [`${pageName}.md`], "page path");
  }

  /** Convert page path (e.g. "incidents/march-outage") to absolute file path */
  function toFilePath(pagePath: string): string {
    return filePathForSegments(validateDocsPathSegments(pagePath, "page path"));
  }

  /** Extract parent folder from a page path ("incidents/march-outage" → "incidents") */
  function folderOf(pagePath: string): string {
    const parts = pagePath.replace(/\\/g, "/").split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  }

  function isReservedName(name: string): boolean {
    return name.startsWith("_");
  }

  function validateDiscoveredPathSegments(input: string, label: "folder" | "page path"): string[] | null {
    try {
      return validateDocsPathSegments(input, label);
    } catch (error) {
      if (error instanceof DocsStoreValidationError) {
        console.warn(`[docs-store] Skipping unsafe ${label} "${input}": ${error.message}`);
        return null;
      }
      throw error;
    }
  }

  function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function buildDbUsageError(mode: "add" | "update", folder?: string): string {
    const targetFolder = folder ?? "folder/name";
    if (mode === "add") {
      return `docs_db_add expects { folder: "${targetFolder}", fields: { title: "Entry title", ... }, body: "# Markdown body" }. If you passed title/category at the top level, nest them under fields.`;
    }
    return `docs_db_update expects { folder: "${targetFolder}", slug: "entry-slug", fields: { ... }, body?: "# Markdown body" }. If you passed field values at the top level, nest them under fields.`;
  }

  function createSafeFieldMap(): Record<string, any> {
    return Object.create(null) as Record<string, any>;
  }

  function assignDbFields(target: Record<string, any>, source: Record<string, any>): void {
    for (const [key, value] of Object.entries(source)) {
      if (DANGEROUS_DB_FIELD_KEYS.has(key)) {
        throw new Error(`Field name "${key}" is not allowed`);
      }
      if (SYSTEM_DB_FIELD_KEYS.has(key)) continue;
      target[key] = value;
    }
  }

  function generateSlug(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "untitled"
    );
  }

  /** Find a unique slug in a folder, appending -2, -3, etc. on collision */
  function resolveSlug(folder: string, baseSlug: string): string {
    const segments = validateDocsPathSegments(folder, "folder");
    let slug = baseSlug;
    let counter = 2;
    while (existsSync(resolveContainedDocsPath(docsRoot, segments, [`${slug}.md`], "folder"))) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    return slug;
  }

  function schemaPath(folder: string): string {
    const segments = validateDocsPathSegments(folder, "folder");
    return resolveContainedDocsPath(docsRoot, segments, ["_schema.yaml"], "folder");
  }

  // ── Schema operations ─────────────────────────────────────────

  function isDbFolder(folder: string): boolean {
    if (!folder) return false; // root is never a DB folder
    return existsSync(schemaPath(folder));
  }

  function readSchema(folder: string): DbSchema | null {
    const sp = schemaPath(folder);
    if (!existsSync(sp)) return null;

    const parsed = parseYaml(readFileSync(sp, "utf-8")) as Record<string, any>;
    return {
      name: parsed.name || folder,
      fields: (parsed.fields || []).map((f: Record<string, any>) => ({
        name: f.name,
        type: VALID_FIELD_TYPES.has(f.type) ? f.type : "text",
        options: f.options,
        required: !!f.required,
      })),
    };
  }

  function writeSchema(folder: string, schema: DbSchema): DbSchema {
    const segments = validateDocsPathSegments(folder, "folder");
    const folderPath = resolveContainedDocsPath(docsRoot, segments, [], "folder");
    if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });

    const yamlContent = stringifyYaml({
      name: schema.name,
      fields: schema.fields.map((f) => {
        const field: Record<string, any> = { name: f.name, type: f.type };
        if (f.options?.length) field.options = f.options;
        if (f.required) field.required = true;
        return field;
      }),
    });

    writeFileSync(schemaPath(folder), yamlContent, "utf-8");
    return readSchema(folder)!;
  }

  // ── Field validation ──────────────────────────────────────────

  function validateFields(schema: DbSchema, fields: Record<string, any>, partial = false): string[] {
    const errors: string[] = [];
    const knownFields = new Set(schema.fields.map((f) => f.name));

    // Reject unknown fields (title and tags are always allowed)
    for (const key of Object.keys(fields)) {
      if (key === "title" || key === "tags") continue;
      if (!knownFields.has(key)) errors.push(`Unknown field: "${key}"`);
    }

    for (const field of schema.fields) {
      const value = fields[field.name];

      // Skip required-field check for partial updates (PATCH)
      if (field.required && !partial && (value === undefined || value === null || value === "")) {
        errors.push(`Required field "${field.name}" is missing`);
        continue;
      }
      if (value === undefined || value === null) continue;

      switch (field.type) {
        case "select":
          if (field.options && !field.options.includes(String(value))) {
            errors.push(`"${field.name}" must be one of: ${field.options.join(", ")}`);
          }
          break;
        case "number":
          if (typeof value !== "number" && isNaN(Number(value))) {
            errors.push(`"${field.name}" must be a number`);
          }
          break;
        case "boolean":
          if (typeof value !== "boolean" && value !== "true" && value !== "false") {
            errors.push(`"${field.name}" must be true or false`);
          }
          break;
        case "date":
          if (isNaN(Date.parse(String(value)))) {
            errors.push(`"${field.name}" must be a valid date`);
          }
          break;
        case "url":
          try { new URL(String(value)); } catch { errors.push(`"${field.name}" must be a valid URL`); }
          break;
      }
    }
    return errors;
  }

  /** Coerce a value to its declared field type */
  function coerceValue(value: any, type: string): any {
    if (value === undefined || value === null) return value;
    switch (type) {
      case "number": return Number(value);
      case "boolean": return value === true || value === "true";
      default: return value;
    }
  }

  // ── Page CRUD ─────────────────────────────────────────────────

  /** Resolve a page path, falling back to folder/index.md if path.md doesn't exist */
  function resolveFilePath(pagePath: string): { filePath: string; canonicalPath: string; usedFolderIndexFallback: boolean; usedExplicitIndexAlias: boolean } | null {
    const parsed = parsePagePath(pagePath);

    if (parsed.isFolderIndexAlias) {
      const indexAliasPath = filePathForSegments(parsed.originalSegments);
      if (existsSync(indexAliasPath)) {
        return {
          filePath: indexAliasPath,
          canonicalPath: parsed.canonicalPath,
          usedFolderIndexFallback: false,
          usedExplicitIndexAlias: true,
        };
      }
      return null;
    }

    const filePath = filePathForSegments(parsed.canonicalSegments);
    if (existsSync(filePath)) {
      return {
        filePath,
        canonicalPath: parsed.canonicalPath,
        usedFolderIndexFallback: false,
        usedExplicitIndexAlias: false,
      };
    }

    // Fall back: if pagePath is a folder with an index.md, use that
    const indexPath = resolveContainedDocsPath(docsRoot, parsed.canonicalSegments, ["index.md"], "page path");
    if (existsSync(indexPath)) {
      return {
        filePath: indexPath,
        canonicalPath: parsed.canonicalPath,
        usedFolderIndexFallback: true,
        usedExplicitIndexAlias: false,
      };
    }

    return null;
  }

  function readPage(pagePath: string): DocPage | null {
    const resolved = resolveFilePath(pagePath);
    if (!resolved) return null;

    const { data, content } = matter(readFileSync(resolved.filePath, "utf-8"));
    const isIndexPage = basename(resolved.filePath) === "index.md";
    const parentFolder = folderOf(resolved.canonicalPath);
    const isDbCollectionIndex = isIndexPage && (isDbFolder(resolved.canonicalPath) || isDbFolder(parentFolder));
    const isRootIndex = isIndexPage && resolved.canonicalPath === "index";
    const isCanonicalFolderIndex = isIndexPage
      && !isRootIndex
      && !isDbCollectionIndex;
    const pageFolder = isCanonicalFolderIndex ? resolved.canonicalPath : parentFolder;
    return {
      path: resolved.canonicalPath,
      title: data.title || (resolved.canonicalPath.split("/").pop() || resolved.canonicalPath),
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
      frontmatter: data,
      body: content.trim(),
      folder: pageFolder,
      isDbItem: !isDbCollectionIndex && isDbFolder(pageFolder),
      isFolderIndex: isIndexPage,
      created: String(data.created || ""),
      modified: String(data.modified || ""),
    };
  }

  function writeDocFile(filePath: string, rawContent: string): void {
    const { data, content } = matter(rawContent);
    validateTaggedDocContent(rawContent);
    const now = new Date().toISOString();

    if (existsSync(filePath)) {
      const existing = matter(readFileSync(filePath, "utf-8")).data;
      data.created = existing.created || data.created || now;
    } else {
      data.created = data.created || now;
    }
    data.modified = now;

    writeFileSync(filePath, matter.stringify(content, data), "utf-8");
  }

  function writePage(pagePath: string, rawContent: string): DocPage {
    const parsed = parsePagePath(pagePath);

    // Validate path
    for (const part of parsed.originalSegments) {
      if (isReservedName(part)) throw new Error(`Reserved name: "${part}" — names starting with _ are reserved`);
    }

    // Write guard: reject writes to DB folders
    const folder = folderOf(parsed.canonicalPath);
    const dbFolder = isDbFolder(parsed.canonicalPath) ? parsed.canonicalPath : folder && isDbFolder(folder) ? folder : "";
    if (dbFolder) {
      throw new Error(
        `Cannot write raw content to DB folder "${dbFolder}" — use docs_db_add with { folder: "${dbFolder}", fields: { title: "Entry title", ... }, body: "# Markdown body" } instead.`,
      );
    }

    let filePath: string;
    if (parsed.isFolderIndexAlias) {
      const leafFilePath = filePathForSegments(parsed.canonicalSegments);
      if (existsSync(leafFilePath)) {
        throw new Error(`Cannot write folder index "${pagePath}" because page "${parsed.canonicalPath}" already exists`);
      }
      filePath = filePathForSegments(parsed.originalSegments);
    } else {
      // Resolve: prefer existing file, fall back to folder/index.md.
      const resolved = resolveFilePath(pagePath);
      if (resolved) {
        filePath = resolved.filePath;
      } else {
        const folderPath = resolveContainedDocsPath(docsRoot, parsed.canonicalSegments, [], "page path");
        const createFolderIndex = parsed.canonicalPath !== "index"
          && existsSync(folderPath)
          && statSync(folderPath).isDirectory();
        filePath = createFolderIndex
          ? resolveContainedDocsPath(docsRoot, parsed.canonicalSegments, ["index.md"], "page path")
          : filePathForSegments(parsed.canonicalSegments);
      }
    }
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeDocFile(filePath, rawContent);
    return readPage(parsed.isFolderIndexAlias ? parsed.canonicalPath + "/index" : parsed.canonicalPath)!;
  }

  function previewEditPageContent(pagePath: string, oldStr: string, newStr: string): string {
    if (!oldStr) throw new Error("old_str must be non-empty");
    const resolved = resolveFilePath(pagePath);
    if (!resolved) throw new Error(`Page not found: ${pagePath}`);
    const filePath = resolved.filePath;

    const raw = readFileSync(filePath, "utf-8");
    const matchCount = raw.split(oldStr).length - 1;
    if (matchCount === 0) throw new Error(`old_str not found in page "${pagePath}"`);
    if (matchCount > 1) throw new Error(`old_str matches ${matchCount} times in "${pagePath}" — include more context to make it unique`);

    return raw.replace(oldStr, newStr);
  }

  function editPage(pagePath: string, oldStr: string, newStr: string): DocPage {
    const updated = previewEditPageContent(pagePath, oldStr, newStr);
    return writePage(pagePath, updated);
  }

  function deletePage(pagePath: string): boolean {
    const resolved = resolveFilePath(pagePath);
    if (!resolved) return false;
    unlinkSync(resolved.filePath);
    return true;
  }

  function readUserPage(pagePath: string): DocPage | null {
    const page = readPage(pagePath);
    if (page?.isDbItem) {
      throw new DocsStoreValidationError(`"${pagePath}" is a database entry. Use docs_db_delete with { folder, slug } to remove it.`);
    }
    return page;
  }

  function deleteUserPage(pagePath: string, beforeDelete?: () => void): { path: string; deleted: boolean } {
    const page = readUserPage(pagePath);
    const canonicalPath = page?.path ?? pagePath;
    if (!page) return { path: canonicalPath, deleted: false };
    beforeDelete?.();
    return { path: canonicalPath, deleted: deletePage(canonicalPath) };
  }

  // ── Tree listing ──────────────────────────────────────────────

  function listTree(folder?: string): DocTreeNode[] {
    const folderSegments = folder ? validateDocsPathSegments(folder, "folder") : [];
    const rootPath = folder ? resolveContainedDocsPath(docsRoot, folderSegments, [], "folder") : docsRoot;
    if (!existsSync(rootPath)) return [];

    const entries = readdirSync(rootPath, { withFileTypes: true });
    const nodes: DocTreeNode[] = [];

    for (const entry of entries) {
      if (isReservedName(entry.name)) continue;

      if (entry.isDirectory()) {
        const childPath = folder ? `${folder}/${entry.name}` : entry.name;
        const childSegments = validateDiscoveredPathSegments(childPath, "folder");
        if (!childSegments) continue;
        const children = listTree(childPath);
        // Check if the child folder itself has an index.md
        const childIndexPath = resolveContainedDocsPath(docsRoot, childSegments, ["index.md"], "folder");
        const childHasIndex = existsSync(childIndexPath);
        nodes.push({
          name: entry.name,
          type: "folder",
          path: childPath,
          isDb: isDbFolder(childPath),
          ...(childHasIndex ? { hasIndex: true } : {}),
          children,
        });
      } else if (entry.name.endsWith(".md")) {
        // Hide index.md from the file list — it's accessed via the folder
        if (entry.name === "index.md") continue;

        const pageName = entry.name.replace(/\.md$/, "");
        const pagePath = folder ? `${folder}/${pageName}` : pageName;
        if (!validateDiscoveredPathSegments(pagePath, "page path")) continue;
        nodes.push({
          name: pageName,
          type: "file",
          path: pagePath,
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // ── DB entry CRUD ─────────────────────────────────────────────

  function normalizeDbEntryInput(input: Record<string, any>, mode: "add" | "update", folder?: string): { fields: Record<string, any>; body?: string } {
    const explicitFields = isPlainObject(input.fields) ? input.fields : undefined;
    let normalizedBody = typeof input.body === "string" ? input.body : undefined;
    const inferredFields = createSafeFieldMap();
    const fields = createSafeFieldMap();

    if (normalizedBody) {
      try {
        const parsed = matter(normalizedBody);
        if (isPlainObject(parsed.data) && Object.keys(parsed.data).length > 0) {
          assignDbFields(inferredFields, parsed.data);
          normalizedBody = parsed.content;
        }
      } catch {
        // Treat malformed or non-object frontmatter-like bodies as plain markdown content.
      }
    }

    for (const [key, value] of Object.entries(input)) {
      if (DB_INPUT_RESERVED_KEYS.has(key) || value === undefined) continue;
      if (DANGEROUS_DB_FIELD_KEYS.has(key)) {
        throw new Error(`Field name "${key}" is not allowed`);
      }
      if (SYSTEM_DB_FIELD_KEYS.has(key)) continue;
      inferredFields[key] = value;
    }

    assignDbFields(fields, inferredFields);
    if (explicitFields) {
      assignDbFields(fields, explicitFields);
    }

    const hasFields = Object.keys(fields).length > 0;
    if (!hasFields && (mode === "add" || normalizedBody === undefined)) {
      throw new Error(buildDbUsageError(mode, folder));
    }

    return { fields, body: normalizedBody };
  }

  function addDbEntry(folder: string, fields: Record<string, any>, body?: string): DbEntry {
    const schema = readSchema(folder);
    if (!schema) throw new Error(`No schema found for folder "${folder}"`);
    if (!fields.title) throw new Error("title is required");

    const errors = validateFields(schema, fields);
    if (errors.length) throw new Error(errors.join("; "));

    const slug = resolveSlug(folder, generateSlug(fields.title));
    const now = new Date().toISOString();

    // Build frontmatter in schema field order
    const fm: Record<string, any> = { title: fields.title };
    for (const field of schema.fields) {
      if (fields[field.name] !== undefined) {
        fm[field.name] = coerceValue(fields[field.name], field.type);
      }
    }
    if (fields.tags) fm.tags = Array.isArray(fields.tags) ? fields.tags : [fields.tags];
    fm.created = now;
    fm.modified = now;

    const folderSegments = validateDocsPathSegments(folder, "folder");
    const filePath = resolveContainedDocsPath(docsRoot, folderSegments, [`${slug}.md`], "folder");
    if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, matter.stringify(body || "", fm), "utf-8");

    return { path: `${folder}/${slug}`, slug, title: fields.title, fields: fm, body: body || "", created: now, modified: now };
  }

  function updateDbEntry(folder: string, slug: string, fields: Record<string, any>, body?: string): DbEntry {
    const schema = readSchema(folder);
    if (!schema) throw new Error(`No schema found for folder "${folder}"`);

    const pagePath = `${folder}/${slug}`;
    const filePath = toFilePath(pagePath);
    if (!existsSync(filePath)) throw new Error(`Entry "${pagePath}" not found`);

    const errors = validateFields(schema, fields, true);
    if (errors.length) throw new Error(errors.join("; "));

    const { data: existing, content: existingContent } = matter(readFileSync(filePath, "utf-8"));
    const merged = { ...existing };

    for (const [key, value] of Object.entries(fields)) {
      if (key === "title" || key === "tags") {
        merged[key] = key === "tags" ? (Array.isArray(value) ? value : [value]) : value;
        continue;
      }
      const fieldDef = schema.fields.find((f) => f.name === key);
      if (fieldDef) merged[key] = coerceValue(value, fieldDef.type);
    }
    merged.modified = new Date().toISOString();

    const newBody = body !== undefined ? body : existingContent.trim();
    writeFileSync(filePath, matter.stringify(newBody, merged), "utf-8");

    return {
      path: pagePath, slug, title: merged.title || slug,
      fields: merged, body: newBody,
      created: merged.created || "", modified: merged.modified,
    };
  }

  function listDbEntries(folder: string): DbEntry[] {
    const segments = validateDocsPathSegments(folder, "folder");
    const folderPath = resolveContainedDocsPath(docsRoot, segments, [], "folder");
    if (!existsSync(folderPath)) return [];

    return readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !isReservedName(e.name))
      .map((e) => {
        const slug = e.name.replace(/\.md$/, "");
        const { data, content } = matter(readFileSync(resolveContainedDocsPath(docsRoot, segments, [e.name], "folder"), "utf-8"));
        return {
          path: `${folder}/${slug}`, slug, title: data.title || slug,
          fields: data, body: content.trim(),
          created: String(data.created || ""), modified: String(data.modified || ""),
        };
      });
  }

  // ── Bulk scan (for index building) ────────────────────────────

  function scanAllPages(): DocPage[] {
    const pages: DocPage[] = [];
    const seen = new Set<string>();
    function walk(dir: string, prefix: string) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (isReservedName(entry.name)) continue;
        if (entry.isDirectory()) {
          const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
          const childSegments = validateDiscoveredPathSegments(childPrefix, "folder");
          if (!childSegments) continue;
          walk(resolveContainedDocsPath(docsRoot, childSegments, [], "folder"), childPrefix);
        } else if (entry.name.endsWith(".md")) {
          let pagePath: string;
          if (entry.name === "index.md") {
            // Canonicalize: folder/index → folder path, root index → "index"
            if (prefix && existsSync(toFilePath(prefix))) continue;
            pagePath = prefix || "index";
          } else {
            pagePath = prefix ? `${prefix}/${entry.name.replace(/\.md$/, "")}` : entry.name.replace(/\.md$/, "");
          }
          if (pagePath) {
            if (!validateDiscoveredPathSegments(pagePath, "page path")) continue;
            const page = readPage(pagePath);
            if (page && !seen.has(page.path)) {
              pages.push(page);
              seen.add(page.path);
            }
          }
        }
      }
    }
    walk(docsRoot, "");
    return pages;
  }

  // ── Tag rename propagation ────────────────────────────────────

  function renameTagInDocs(oldName: string, newName: string): number {
    let updated = 0;
    const pages = scanAllPages();
    for (const page of pages) {
      const idx = page.tags.findIndex((t) => t.toLowerCase() === oldName.toLowerCase());
      if (idx === -1) continue;

      const resolved = resolveFilePath(page.path);
      if (!resolved) continue;

      const raw = readFileSync(resolved.filePath, "utf-8");
      const { data, content } = matter(raw);
      const tags: string[] = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
      const tagIdx = tags.findIndex((t) => t.toLowerCase() === oldName.toLowerCase());
      if (tagIdx === -1) continue;

      tags[tagIdx] = newName;
      data.tags = tags;
      writeDocFile(resolved.filePath, matter.stringify(content, data));
      updated++;
    }
    return updated;
  }

  // ── Folder operations ─────────────────────────────────────────

  function deleteFolder(folder: string): boolean {
    const segments = validateDocsPathSegments(folder, "folder");
    const folderPath = resolveContainedDocsPath(docsRoot, segments, [], "folder");
    if (!existsSync(folderPath)) return false;
    rmSync(folderPath, { recursive: true });
    return true;
  }

  return {
    readPage, readUserPage, writePage, previewEditPageContent, editPage, deletePage, deleteUserPage, listTree, scanAllPages, deleteFolder,
    readSchema, writeSchema, isDbFolder,
    normalizeDbEntryInput,
    addDbEntry, updateDbEntry, listDbEntries,
    generateSlug, docsDir, renameTagInDocs,
  };
}

export type DocsStore = ReturnType<typeof createDocsStore>;

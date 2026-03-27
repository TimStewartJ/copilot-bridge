import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
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
  created: string;
  modified: string;
}

export interface DocTreeNode {
  name: string;
  type: "file" | "folder";
  path: string;
  isDb?: boolean;
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

// ── Factory ───────────────────────────────────────────────────────

export function createDocsStore(docsDir: string) {
  if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

  // ── Path helpers ──────────────────────────────────────────────

  /** Convert page path (e.g. "incidents/march-outage") to absolute file path */
  function toFilePath(pagePath: string): string {
    const normalized = pagePath.replace(/\\/g, "/").replace(/\.md$/, "");
    return join(docsDir, ...normalized.split("/")) + ".md";
  }

  /** Extract parent folder from a page path ("incidents/march-outage" → "incidents") */
  function folderOf(pagePath: string): string {
    const parts = pagePath.replace(/\\/g, "/").split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  }

  function isReservedName(name: string): boolean {
    return name.startsWith("_");
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
    const folderPath = join(docsDir, ...folder.split("/"));
    let slug = baseSlug;
    let counter = 2;
    while (existsSync(join(folderPath, slug + ".md"))) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    return slug;
  }

  function schemaPath(folder: string): string {
    return join(docsDir, ...folder.split("/"), "_schema.yaml");
  }

  // ── Schema operations ─────────────────────────────────────────

  function isDbFolder(folder: string): boolean {
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
    const folderPath = join(docsDir, ...folder.split("/"));
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

  function readPage(pagePath: string): DocPage | null {
    const filePath = toFilePath(pagePath);
    if (!existsSync(filePath)) return null;

    const { data, content } = matter(readFileSync(filePath, "utf-8"));
    return {
      path: pagePath,
      title: data.title || basename(pagePath),
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
      frontmatter: data,
      body: content.trim(),
      folder: folderOf(pagePath),
      created: data.created || "",
      modified: data.modified || "",
    };
  }

  function writePage(pagePath: string, rawContent: string): DocPage {
    // Validate path
    for (const part of pagePath.split("/")) {
      if (isReservedName(part)) throw new Error(`Reserved name: "${part}" — names starting with _ are reserved`);
    }

    // Write guard: reject writes to DB folders
    const folder = folderOf(pagePath);
    if (folder && isDbFolder(folder)) {
      throw new Error(`Cannot write raw content to DB folder "${folder}" — use docs_db_add instead`);
    }

    const filePath = toFilePath(pagePath);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Parse incoming content for frontmatter
    const { data, content } = matter(rawContent);
    const now = new Date().toISOString();

    // Preserve created timestamp from existing file
    if (existsSync(filePath)) {
      const existing = matter(readFileSync(filePath, "utf-8")).data;
      data.created = existing.created || data.created || now;
    } else {
      data.created = data.created || now;
    }
    data.modified = now;

    writeFileSync(filePath, matter.stringify(content, data), "utf-8");
    return readPage(pagePath)!;
  }

  function editPage(pagePath: string, oldStr: string, newStr: string): DocPage {
    if (!oldStr) throw new Error("old_str must be non-empty");
    const filePath = toFilePath(pagePath);
    if (!existsSync(filePath)) throw new Error(`Page not found: ${pagePath}`);

    const raw = readFileSync(filePath, "utf-8");
    const matchCount = raw.split(oldStr).length - 1;
    if (matchCount === 0) throw new Error(`old_str not found in page "${pagePath}"`);
    if (matchCount > 1) throw new Error(`old_str matches ${matchCount} times in "${pagePath}" — include more context to make it unique`);

    const updated = raw.replace(oldStr, newStr);
    return writePage(pagePath, updated);
  }

  function deletePage(pagePath: string): boolean {
    const filePath = toFilePath(pagePath);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  // ── Tree listing ──────────────────────────────────────────────

  function listTree(folder?: string): DocTreeNode[] {
    const rootPath = folder ? join(docsDir, ...folder.split("/")) : docsDir;
    if (!existsSync(rootPath)) return [];

    const entries = readdirSync(rootPath, { withFileTypes: true });
    const nodes: DocTreeNode[] = [];

    for (const entry of entries) {
      if (isReservedName(entry.name)) continue;

      if (entry.isDirectory()) {
        const childPath = folder ? `${folder}/${entry.name}` : entry.name;
        nodes.push({
          name: entry.name,
          type: "folder",
          path: childPath,
          isDb: isDbFolder(childPath),
          children: listTree(childPath),
        });
      } else if (entry.name.endsWith(".md")) {
        const pageName = entry.name.replace(/\.md$/, "");
        nodes.push({
          name: pageName,
          type: "file",
          path: folder ? `${folder}/${pageName}` : pageName,
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // ── DB entry CRUD ─────────────────────────────────────────────

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

    const filePath = join(docsDir, ...folder.split("/"), slug + ".md");
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
    const folderPath = join(docsDir, ...folder.split("/"));
    if (!existsSync(folderPath)) return [];

    return readdirSync(folderPath, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !isReservedName(e.name))
      .map((e) => {
        const slug = e.name.replace(/\.md$/, "");
        const { data, content } = matter(readFileSync(join(folderPath, e.name), "utf-8"));
        return {
          path: `${folder}/${slug}`, slug, title: data.title || slug,
          fields: data, body: content.trim(),
          created: data.created || "", modified: data.modified || "",
        };
      });
  }

  // ── Bulk scan (for index building) ────────────────────────────

  function scanAllPages(): DocPage[] {
    const pages: DocPage[] = [];
    function walk(dir: string, prefix: string) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (isReservedName(entry.name)) continue;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith(".md")) {
          const pagePath = prefix ? `${prefix}/${entry.name.replace(/\.md$/, "")}` : entry.name.replace(/\.md$/, "");
          const page = readPage(pagePath);
          if (page) pages.push(page);
        }
      }
    }
    walk(docsDir, "");
    return pages;
  }

  // ── Folder operations ─────────────────────────────────────────

  function deleteFolder(folder: string): boolean {
    const folderPath = join(docsDir, ...folder.split("/"));
    if (!existsSync(folderPath)) return false;
    rmSync(folderPath, { recursive: true });
    return true;
  }

  return {
    readPage, writePage, editPage, deletePage, listTree, scanAllPages, deleteFolder,
    readSchema, writeSchema, isDbFolder,
    addDbEntry, updateDbEntry, listDbEntries,
    generateSlug, docsDir,
  };
}

export type DocsStore = ReturnType<typeof createDocsStore>;

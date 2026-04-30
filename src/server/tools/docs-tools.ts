import { defineTool } from "@github/copilot-sdk";
import matter from "gray-matter";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";

const TAGGED_DOC_DESCRIPTION_ERROR = "Tagged docs must include a non-empty frontmatter description";

function normalizeDocsToolFailure(error: unknown) {
  return toolFailure(error instanceof Error ? error.message : String(error));
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

function validateTaggedDocContent(content: string): void {
  const { data } = matter(content);
  const tags = getTaggedDocFrontmatterTags(data);
  if (tags.length === 0) return;
  if (typeof data.description !== "string" || !data.description.trim()) {
    throw new Error(TAGGED_DOC_DESCRIPTION_ERROR);
  }
}

export function createDocsTools(ctx: AppContext) {
  return ctx.docsStore && ctx.docsIndex ? [
    defineTool("docs_search", {
      description: "Search the knowledge base using full-text search. Returns matching pages with titles, snippets, and relevance scores.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search query text" }, limit: { type: "number", description: "Max results (default 20)" }, offset: { type: "number", description: "Offset for pagination (default 0)" } }, required: ["query"] },
      handler: async (args: any) => ctx.docsIndex!.search(args.query, args.limit ?? 20, args.offset ?? 0),
    }),
    defineTool("docs_read", {
      description: "Read a knowledge base page by its path. Returns frontmatter metadata and markdown body.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'incidents/march-outage')" } }, required: ["path"] },
      handler: async (args: any) => {
        try {
          const page = ctx.docsStore!.readPage(args.path);
          if (!page) return toolFailure(`Page not found: ${args.path}`);
          return { path: page.path, title: page.title, tags: page.tags, frontmatter: page.frontmatter, body: page.body };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_write", {
      description: "Create or update a knowledge base page. Provide raw markdown content (with optional YAML frontmatter). Tagged or reference pages should include frontmatter title, description, and tags so the bridge can surface them to agents. Supports [[wikilinks]] — use [[page-path]] or [[page-path|Display Text]] to link between pages (resolved by path, title, or slug). Rejects writes to database collection folders — for those, use docs_db_add with { folder, fields: { title, ... }, body }.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" }, content: { type: "string", description: "Raw markdown content (may include YAML frontmatter)" } }, required: ["path", "content"] },
      handler: async (args: any) => {
        try {
          validateTaggedDocContent(args.content);
          const page = ctx.docsStore!.writePage(args.path, args.content);
          ctx.docsIndex!.indexPage(page);
          return { path: page.path, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_edit", {
      description: "Make a surgical string replacement in a knowledge base page. Finds exactly one occurrence of old_str in the raw markdown (frontmatter + body) and replaces it with new_str. Tagged or reference pages must still include a frontmatter description after the edit. Supports [[wikilinks]] — use [[page-path]] or [[page-path|Display Text]] to link between pages. Errors if old_str is not found or matches multiple times — include more surrounding context to disambiguate.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" }, old_str: { type: "string", description: "The exact string to find in the raw page content" }, new_str: { type: "string", description: "The replacement string" } }, required: ["path", "old_str", "new_str"] },
      handler: async (args: any) => {
        try {
          const updatedContent = ctx.docsStore!.previewEditPageContent(args.path, args.old_str, args.new_str);
          validateTaggedDocContent(updatedContent);
          const page = ctx.docsStore!.writePage(args.path, updatedContent);
          ctx.docsIndex!.indexPage(page);
          return { path: page.path, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_list", {
      description: "List pages and folders in the knowledge base. Returns a tree structure with file/folder types and database folder indicators.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Folder path to list (omit for root)" } }, required: [] },
      handler: async (args: any) => {
        try {
          return { tree: ctx.docsStore!.listTree(args.folder) };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_schema", {
      description: "Get the schema for a database collection folder. Returns field names, types, options, and entry count. Call this before docs_db_add to discover valid fields.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" } }, required: ["folder"] },
      handler: async (args: any) => {
        try {
          const schema = ctx.docsStore!.readSchema(args.folder);
          if (!schema) return toolFailure(`No schema found for folder "${args.folder}"`);
          const entries = ctx.docsStore!.listDbEntries(args.folder);
          return { ...schema, entryCount: entries.length };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_add", {
      description: "Create a new entry in a database collection. Preferred shape: { folder: 'incidents', fields: { title: 'March Outage', severity: 'sev1' }, body: '# Notes' }. The server validates fields against the schema and generates the markdown file.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, fields: { type: "object", description: "Field values as key-value pairs. Preferred shape: { title: 'Entry title', ... }." }, body: { type: "string", description: "Optional markdown body content for the entry" } }, required: ["folder"] },
      handler: async (args: any) => {
        try {
          const { fields, body } = ctx.docsStore!.normalizeDbEntryInput(args, "add", args.folder);
          const entry = ctx.docsStore!.addDbEntry(args.folder, fields, body);
          const page = ctx.docsStore!.readPage(entry.path);
          if (page) ctx.docsIndex!.indexPage(page);
          return { path: entry.path, slug: entry.slug, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_update", {
      description: "Update an existing database entry. Preferred shape: { folder: 'incidents', slug: 'march-outage', fields: { severity: 'sev2' }, body?: '# Updated notes' }. Only changed fields are updated; other fields are preserved.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, slug: { type: "string", description: "Entry slug (filename without .md, returned by docs_db_add or docs_db_query)" }, fields: { type: "object", description: "Field values to update (preferred shape: { fieldName: value })." }, body: { type: "string", description: "Optional new markdown body content" } }, required: ["folder", "slug"] },
      handler: async (args: any) => {
        try {
          const { fields, body } = ctx.docsStore!.normalizeDbEntryInput(args, "update", args.folder);
          const entry = ctx.docsStore!.updateDbEntry(args.folder, args.slug, fields, body);
          const page = ctx.docsStore!.readPage(entry.path);
          if (page) ctx.docsIndex!.indexPage(page);
          return { path: entry.path, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_query", {
      description: "Query entries in a database collection by field values. Supports equality filters, multi-value OR (pass array), pagination, sorting, and optional markdown body inclusion.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, filters: { type: "object", description: "Field filters as key-value pairs. Arrays match any value (OR). Example: { severity: 'sev1' } or { severity: ['sev1', 'sev2'] }" }, includeBody: { type: "boolean", description: "When true, include each entry's markdown body content in the response." }, _sort: { type: "string", description: "Field to sort by (default: 'modified')" }, _order: { type: "string", enum: ["asc", "desc"], description: "Sort order (default: 'desc')" }, _limit: { type: "number", description: "Max results (default 50)" }, _offset: { type: "number", description: "Offset for pagination (default 0)" } }, required: ["folder"] },
      handler: async (args: any) => {
        return ctx.docsIndex!.queryByFolder(
          args.folder,
          args.filters,
          args._sort ? { field: args._sort, order: args._order ?? "desc" } : undefined,
          args._limit ?? 50,
          args._offset ?? 0,
          args.includeBody === true,
        );
      },
    }),
    defineTool("docs_db_create", {
      description: "Create a new database collection by defining a schema. Creates a folder with a _schema.yaml file. Supported field types: text, select, date, number, boolean, url.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Folder name for the new database (e.g., 'incidents')" }, name: { type: "string", description: "Human-readable name for the database (e.g., 'Incidents')" }, fields: { type: "array", description: "Array of field definitions", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["text", "select", "date", "number", "boolean", "url"] }, options: { type: "array", items: { type: "string" }, description: "Options for select fields" }, required: { type: "boolean" } }, required: ["name", "type"] } } }, required: ["folder", "name", "fields"] },
      handler: async (args: any) => {
        try {
          ctx.docsStore!.writeSchema(args.folder, { name: args.name, fields: args.fields });
          return { folder: args.folder, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_delete", {
      description: "Delete a knowledge base page permanently. Returns whether the page was found and deleted. Cannot delete pages inside database collections — use docs_db_delete for those.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" } }, required: ["path"] },
      handler: async (args: any) => {
        try {
          const pagePath: string = args.path;
          // Guard: don't allow deleting DB entries via this tool
          const page = ctx.docsStore!.readPage(pagePath);
          if (page?.isDbItem) {
            return toolFailure(`"${pagePath}" is a database entry. Use docs_db_delete with { folder, slug } to remove it.`);
          }
          const canonicalPath = page?.path ?? pagePath;
          const deleted = ctx.docsStore!.deletePage(pagePath);
          if (deleted) ctx.docsIndex!.removePage(canonicalPath);
          return { path: canonicalPath, deleted };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_delete", {
      description: "Delete an entry from a database collection permanently. Removes the markdown file for the entry.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, slug: { type: "string", description: "Entry slug (filename without .md, returned by docs_db_add or docs_db_query)" } }, required: ["folder", "slug"] },
      handler: async (args: any) => {
        try {
          const schema = ctx.docsStore!.readSchema(args.folder);
          if (!schema) return toolFailure(`No database collection found at "${args.folder}"`);
          const pagePath = `${args.folder}/${args.slug}`;
          // Verify it's actually a DB entry
          const page = ctx.docsStore!.readPage(pagePath);
          if (page && !page.isDbItem) {
            return toolFailure(`"${pagePath}" is not a database entry`);
          }
          const deleted = ctx.docsStore!.deletePage(pagePath);
          if (deleted) ctx.docsIndex!.removePage(pagePath);
          return { folder: args.folder, slug: args.slug, deleted };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
  ] : [];
}

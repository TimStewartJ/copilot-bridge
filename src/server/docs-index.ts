import { getDocsFtsHealth, initializeDocsFts, type DatabaseSync, type DocsFtsHealth } from "./db.js";
import { normalizeDocsPublicPath, validateDocsPathSegments, type DocsStore, type DocPage } from "./docs-store.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  folder: string;
  tags: string[];
}

export interface ResolvedLink {
  path: string;
  title: string;
}

export interface RelatedDocMatch {
  path: string;
  title: string;
  tags: string[];
  folder: string;
  modified: string;
  description?: string;
  matchedTags: string[];
}

export const DOCS_FTS_UNAVAILABLE_CODE = "docs_fts_unavailable" as const;

export interface DocsFtsUnavailablePayload {
  error: string;
  code: typeof DOCS_FTS_UNAVAILABLE_CODE;
  operation: string;
  health: DocsFtsHealth;
}

export type DocsFtsMutationResult =
  | { indexed: true }
  | { indexed: false; indexError: DocsFtsUnavailablePayload };

function formatDocsFtsUnavailableMessage(operation: string, health: DocsFtsHealth): string {
  if (health.ok) {
    return `Docs full-text search is unavailable while attempting to ${operation}.`;
  }
  return `Docs full-text search is unavailable while attempting to ${operation}: ${health.message} Cause: ${health.cause}`;
}

export class DocsFtsUnavailableError extends Error {
  readonly code = DOCS_FTS_UNAVAILABLE_CODE;
  readonly operation: string;
  readonly health: DocsFtsHealth;

  constructor(operation: string, health: DocsFtsHealth) {
    super(formatDocsFtsUnavailableMessage(operation, health));
    this.name = "DocsFtsUnavailableError";
    this.operation = operation;
    this.health = health;
  }
}

export function isDocsFtsUnavailableError(error: unknown): error is DocsFtsUnavailableError {
  return error instanceof DocsFtsUnavailableError;
}

export function docsFtsUnavailablePayload(error: DocsFtsUnavailableError): DocsFtsUnavailablePayload {
  return {
    error: error.message,
    code: error.code,
    operation: error.operation,
    health: error.health,
  };
}

const TAG_MATCH_COLLATOR = new Intl.Collator("und", { usage: "search", sensitivity: "accent" });

const DOCS_SNIPPET_SQL = `
  SELECT
    docs_pages.path,
    docs_pages.title,
    docs_pages.folder,
    docs_pages.tags,
    snippet(docs_fts, 3, '<mark>', '</mark>', '...', 40) as snippet,
    rank as score
  FROM docs_fts
  JOIN docs_pages ON docs_pages.rowid = docs_fts.rowid
  WHERE docs_fts MATCH ?
  ORDER BY rank
  LIMIT ? OFFSET ?
`;

// ── Factory ───────────────────────────────────────────────────────

export function createDocsIndex(db: DatabaseSync, docsStore: DocsStore) {
  function tagsMatch(a: string, b: string): boolean {
    if (TAG_MATCH_COLLATOR.compare(a, b) === 0) return true;
    return a.normalize("NFC").toLocaleUpperCase("und") === b.normalize("NFC").toLocaleUpperCase("und");
  }

  function parseFrontmatter(frontmatterJson?: string): Record<string, unknown> {
    return frontmatterJson ? JSON.parse(frontmatterJson) as Record<string, unknown> : {};
  }

  function extractDocTags(frontmatter: Record<string, unknown>, fallbackTags?: string): string[] {
    const frontmatterTags = frontmatter.tags;
    if (Array.isArray(frontmatterTags)) return frontmatterTags.filter((tag): tag is string => typeof tag === "string");
    if (typeof frontmatterTags === "string") return [frontmatterTags];
    return fallbackTags ? fallbackTags.split(", ").filter(Boolean) : [];
  }

  function runInTransaction<T>(operation: () => T): T {
    db.exec("BEGIN");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function rebuildFtsFromContent(): void {
    db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
  }

  function getFtsHealth(): DocsFtsHealth {
    return getDocsFtsHealth(db);
  }

  function ensureFtsAvailable(operation: string, options: { retryInit?: boolean } = {}): void {
    let health = getDocsFtsHealth(db);
    if (!health.ok && options.retryInit) {
      health = initializeDocsFts(db, { warnOnFailure: false });
    }
    if (!health.ok) throw new DocsFtsUnavailableError(operation, health);
  }

  function skippedFtsMutation(operation: string): DocsFtsMutationResult | null {
    const health = getDocsFtsHealth(db);
    if (health.ok) return null;
    return {
      indexed: false,
      indexError: docsFtsUnavailablePayload(new DocsFtsUnavailableError(operation, health)),
    };
  }

  function isRecoverableFtsError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("database disk image is malformed")
      || (message.includes("database") && message.includes("malformed"))
      || message.includes("database corruption");
  }

  function withFtsRepair<T>(operationName: string, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!isRecoverableFtsError(error)) throw error;
      ensureFtsAvailable(`repair docs FTS for ${operationName}`);
      rebuildFtsFromContent();
      return operation();
    }
  }

  // ── Index management ──────────────────────────────────────────

  /** Rebuild the entire index from files on disk */
  function reindex(): { indexed: number } {
    ensureFtsAvailable("reindex docs", { retryInit: true });
    const pages = docsStore.scanAllPages();
    runInTransaction(() => {
      db.exec("DELETE FROM docs_pages");
      const insert = db.prepare(`
        INSERT OR REPLACE INTO docs_pages (path, title, tags, body, frontmatter_json, folder, created, modified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const page of pages) {
        const tagsStr = page.tags.join(", ");
        const fmJson = JSON.stringify(page.frontmatter);
        insert.run(
          page.path, page.title, tagsStr, page.body,
          fmJson, page.folder, page.created, page.modified,
        );
      }
      rebuildFtsFromContent();
    });

    return { indexed: pages.length };
  }

  /** Index a single page (after create or update) */
  function indexPage(page: DocPage): DocsFtsMutationResult {
    const skipped = skippedFtsMutation("index docs page");
    const tagsStr = page.tags.join(", ");
    const fmJson = JSON.stringify(page.frontmatter);
    if (skipped) {
      runInTransaction(() => {
        upsertDocsPageRow(page, tagsStr, fmJson);
      });
      return skipped;
    }

    withFtsRepair("index docs page", () => {
      runInTransaction(() => {
        const existing = db.prepare("SELECT rowid FROM docs_pages WHERE path = ?").get(page.path) as any;
        if (existing) {
          // With external-content FTS, remove the old indexed row before mutating docs_pages.
          // Otherwise SQLite can fail when the content table body/title has already changed.
          db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(existing.rowid);
          db.prepare(`
            UPDATE docs_pages SET title=?, tags=?, body=?, frontmatter_json=?, folder=?, created=?, modified=?
            WHERE path=?
          `).run(page.title, tagsStr, page.body, fmJson, page.folder, page.created, page.modified, page.path);
          db.prepare("INSERT INTO docs_fts (rowid, path, title, tags, body) VALUES (?, ?, ?, ?, ?)").run(
            existing.rowid, page.path, page.title, tagsStr, page.body,
          );
        } else {
          insert(page, tagsStr, fmJson);
        }
      });
    });
    return { indexed: true };
  }

  function upsertDocsPageRow(page: DocPage, tagsStr: string, fmJson: string): number | null {
    const existing = db.prepare("SELECT rowid FROM docs_pages WHERE path = ?").get(page.path) as any;
    if (existing) {
      db.prepare(`
        UPDATE docs_pages SET title=?, tags=?, body=?, frontmatter_json=?, folder=?, created=?, modified=?
        WHERE path=?
      `).run(page.title, tagsStr, page.body, fmJson, page.folder, page.created, page.modified, page.path);
      return existing.rowid;
    }

    db.prepare(`
      INSERT OR REPLACE INTO docs_pages (path, title, tags, body, frontmatter_json, folder, created, modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(page.path, page.title, tagsStr, page.body, fmJson, page.folder, page.created, page.modified);
    const row = db.prepare("SELECT rowid FROM docs_pages WHERE path = ?").get(page.path) as any;
    return row?.rowid ?? null;
  }

  function insert(page: DocPage, tagsStr: string, fmJson: string): void {
    const rowid = upsertDocsPageRow(page, tagsStr, fmJson);
    if (rowid !== null) {
      db.prepare("INSERT INTO docs_fts (rowid, path, title, tags, body) VALUES (?, ?, ?, ?, ?)").run(
        rowid, page.path, page.title, tagsStr, page.body,
      );
    }
  }

  /** Remove a page from the index */
  function removePage(pagePath: string): DocsFtsMutationResult {
    const skipped = skippedFtsMutation("remove docs page from search index");
    if (skipped) {
      db.prepare("DELETE FROM docs_pages WHERE path = ?").run(pagePath);
      return skipped;
    }

    withFtsRepair("remove docs page from search index", () => {
      runInTransaction(() => {
        const existing = db.prepare("SELECT rowid FROM docs_pages WHERE path = ?").get(pagePath) as any;
        if (existing) {
          db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(existing.rowid);
          db.prepare("DELETE FROM docs_pages WHERE path = ?").run(pagePath);
        }
      });
    });
    return { indexed: true };
  }

  /** Remove all pages under a folder from the index */
  function removeFolder(folder: string): DocsFtsMutationResult {
    const skipped = skippedFtsMutation("remove docs folder from search index");
    if (skipped) {
      db.prepare("DELETE FROM docs_pages WHERE path LIKE ? || '%'").run(folder);
      return skipped;
    }

    withFtsRepair("remove docs folder from search index", () => {
      runInTransaction(() => {
        const rows = db.prepare("SELECT rowid FROM docs_pages WHERE path LIKE ? || '%'").all(folder) as any[];
        for (const row of rows) {
          db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(row.rowid);
        }
        db.prepare("DELETE FROM docs_pages WHERE path LIKE ? || '%'").run(folder);
      });
    });
    return { indexed: true };
  }

  // ── Search ────────────────────────────────────────────────────

  function search(query: string, limit = 50, offset = 0): { results: SearchResult[]; total: number } {
    if (!query.trim()) return { results: [], total: 0 };
    ensureFtsAvailable("search docs");

    // Sanitize query for FTS5 — wrap terms in quotes to avoid syntax errors
    const sanitized = query
      .replace(/['"]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term}"`)
      .join(" ");

    if (!sanitized) return { results: [], total: 0 };

    return withFtsRepair("search docs", () => {
      const countRow = db.prepare(`
        SELECT count(*) as total FROM docs_fts WHERE docs_fts MATCH ?
      `).get(sanitized) as any;
      const total = countRow?.total || 0;

      const rows = db.prepare(DOCS_SNIPPET_SQL).all(sanitized, limit, offset) as any[];

      return {
        total,
        results: rows.map((r) => ({
          path: r.path,
          title: r.title || r.path,
          snippet: r.snippet || "",
          score: r.score,
          folder: r.folder || "",
          tags: r.tags ? r.tags.split(", ").filter(Boolean) : [],
        })),
      };
    });
  }

  // ── Structured queries (for DB collections) ───────────────────

  function queryByFolder(
    folder: string,
    filters?: Record<string, any>,
    sort?: { field: string; order: "asc" | "desc" },
    limit = 50,
    offset = 0,
    includeBody = false,
  ): { entries: any[]; total: number } {
    const normalizedFolder = validateDocsPathSegments(folder, "folder").join("/");
    let where = "folder = ?";
    const params: any[] = [normalizedFolder];

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (key.startsWith("_")) continue; // skip meta-params
        if (Array.isArray(value)) {
          // Multi-value OR
          const placeholders = value.map(() => "?").join(", ");
          where += ` AND json_extract(frontmatter_json, '$.${key}') IN (${placeholders})`;
          params.push(...value.map(String));
        } else {
          where += ` AND json_extract(frontmatter_json, '$.${key}') = ?`;
          params.push(String(value));
        }
      }
    }

    const sortField = sort?.field || "modified";
    const sortOrder = sort?.order === "asc" ? "ASC" : "DESC";
    // For known columns, sort directly; for frontmatter fields, use json_extract
    const knownColumns = new Set(["path", "title", "folder", "created", "modified"]);
    const orderBy = knownColumns.has(sortField)
      ? `${sortField} ${sortOrder}`
      : `json_extract(frontmatter_json, '$.${sortField}') ${sortOrder}`;

    const countRow = db.prepare(`SELECT count(*) as total FROM docs_pages WHERE ${where}`).get(...params) as any;
    const total = countRow?.total || 0;

    const rows = db.prepare(`
      SELECT path, title, tags, frontmatter_json, folder, created, modified${includeBody ? ", body" : ""}
      FROM docs_pages
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      total,
      entries: rows.map((r) => ({
        path: r.path,
        slug: r.path.split("/").pop() || r.path,
        title: r.title || r.path,
        fields: r.frontmatter_json ? JSON.parse(r.frontmatter_json) : {},
        tags: r.tags ? r.tags.split(", ").filter(Boolean) : [],
        created: r.created || "",
        modified: r.modified || "",
        ...(includeBody ? { body: r.body || "" } : {}),
      })),
    };
  }

  // ── Wikilink resolution ────────────────────────────────────────

  function resolveWikilink(target: string): ResolvedLink | null {
    const candidates = [target];
    let normalizedTarget: string | null = null;
    try {
      normalizedTarget = normalizeDocsPublicPath(target);
    } catch {
      // Invalid path-like targets may still match page titles below.
    }
    if (normalizedTarget && normalizedTarget !== target) candidates.push(normalizedTarget);

    // 1. Exact path match
    for (const candidate of candidates) {
      const exact = db.prepare("SELECT path, title FROM docs_pages WHERE path = ?").get(candidate) as any;
      if (exact) return { path: exact.path, title: exact.title || exact.path };
    }

    // 2. Case-insensitive path match
    for (const candidate of candidates) {
      const ciPath = db.prepare("SELECT path, title FROM docs_pages WHERE path = ? COLLATE NOCASE").get(candidate) as any;
      if (ciPath) return { path: ciPath.path, title: ciPath.title || ciPath.path };
    }

    // 3. Title match (exact then case-insensitive)
    const byTitle = db.prepare("SELECT path, title FROM docs_pages WHERE title = ?").get(target) as any;
    if (byTitle) return { path: byTitle.path, title: byTitle.title };
    const ciTitle = db.prepare("SELECT path, title FROM docs_pages WHERE title = ? COLLATE NOCASE").get(target) as any;
    if (ciTitle) return { path: ciTitle.path, title: ciTitle.title };

    // 4. Slug match — target as the last path segment
    const slugMatch = db.prepare(
      "SELECT path, title FROM docs_pages WHERE path LIKE '%/' || ? OR path = ?",
    ).get(target, target) as any;
    if (slugMatch) return { path: slugMatch.path, title: slugMatch.title || slugMatch.path };

    return null;
  }

  function resolveWikilinks(targets: string[]): Record<string, ResolvedLink | null> {
    const result: Record<string, ResolvedLink | null> = {};
    for (const t of targets) {
      result[t] = resolveWikilink(t);
    }
    return result;
  }

  /** Find docs whose frontmatter tags match any of the given tag names (case-insensitive) */
  function findDocsByTagNames(tagNames: string[], limit = 50): RelatedDocMatch[] {
    if (tagNames.length === 0) return [];

    const rows = db.prepare(`
      SELECT path, title, tags, folder, modified, frontmatter_json
      FROM docs_pages
      WHERE tags IS NOT NULL AND tags != ''
      ORDER BY modified DESC
    `).all() as any[];

    return rows
      .map((r) => {
        const frontmatter = parseFrontmatter(typeof r.frontmatter_json === "string" ? r.frontmatter_json : undefined);
        const tags = extractDocTags(frontmatter, typeof r.tags === "string" ? r.tags : undefined);
        const matchedTags = tagNames.filter((candidate) => tags.some((tag) => tagsMatch(tag, candidate)));
        return {
          path: r.path as string,
          title: (r.title || r.path) as string,
          tags,
          folder: (r.folder || "") as string,
          modified: (r.modified || "") as string,
          description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
          matchedTags,
        };
      })
      .filter((doc) => doc.matchedTags.length > 0)
      .slice(0, limit);
  }

  return {
    reindex, indexPage, removePage, removeFolder,
    search, queryByFolder, resolveWikilink, resolveWikilinks,
    findDocsByTagNames, getFtsHealth,
  };
}

export type DocsIndex = ReturnType<typeof createDocsIndex>;

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDatabase } from "../db.js";
import { createDocsStore } from "../docs-store.js";
import { createDocsIndex } from "../docs-index.js";

const tempDirs: string[] = [];

function createIndexFixture() {
  const docsDir = mkdtempSync(join(tmpdir(), "docs-index-test-"));
  tempDirs.push(docsDir);

  const db = openMemoryDatabase();
  const docsStore = createDocsStore(docsDir);
  docsStore.writePage("searchable", "# Searchable Page\n\nThis page contains xylophone content.");

  const docsIndex = createDocsIndex(db, docsStore);
  docsIndex.reindex();

  return { db, docsIndex };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("docs index recovery", () => {
  it("repairs recoverable FTS search failures and retries once", () => {
    const { db, docsIndex } = createIndexFixture();
    const realPrepare = db.prepare.bind(db);
    const realExec = db.exec.bind(db);
    let snippetFailures = 0;
    let rebuilds = 0;

    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("snippet(docs_fts") && snippetFailures === 0) {
        snippetFailures += 1;
        throw new Error("database disk image is malformed");
      }
      return realPrepare(sql);
    });
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')")) {
        rebuilds += 1;
      }
      return realExec(sql);
    });

    const result = docsIndex.search("xylophone");

    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe("searchable");
    expect(snippetFailures).toBe(1);
    expect(rebuilds).toBe(1);
  });

  it("reindex repopulates docs_pages and rebuilds FTS from content", () => {
    const { db, docsIndex } = createIndexFixture();
    const realExec = db.exec.bind(db);
    let rebuilds = 0;

    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')")) {
        rebuilds += 1;
      }
      return realExec(sql);
    });

    const result = docsIndex.reindex();
    const search = docsIndex.search("xylophone");

    expect(result.indexed).toBe(1);
    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.path).toBe("searchable");
    expect(rebuilds).toBe(1);
  });
});

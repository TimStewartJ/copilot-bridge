import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getDocsFtsHealth, initializeDocsFts, openDatabase, openMemoryDatabase } from "../db.js";
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

  return { db, docsIndex, docsStore };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("docs index recovery", () => {
  it("self-heals a conflicting docs_fts table and preserves it under quarantine", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "docs-fts-db-test-"));
    const docsDir = mkdtempSync(join(tmpdir(), "docs-fts-docs-test-"));
    tempDirs.push(dataDir, docsDir);
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    legacyDb.exec("CREATE TABLE docs_fts(dummy TEXT)");
    legacyDb.prepare("INSERT INTO docs_fts(dummy) VALUES (?)").run("operator data");
    legacyDb.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const db = openDatabase(dataDir);
    try {
      const health = getDocsFtsHealth(db);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("[docs-fts]");
      expect(warn.mock.calls[0]?.[0]).toContain("Repaired docs full-text search index");
      expect(health).toMatchObject({
        ok: true,
        status: "available",
        repaired: true,
        previousFailure: {
          detectedBy: "schema_probe",
        },
      });
      expect(health.ok ? health.quarantinedTable : "").toMatch(/^quarantined_docs_fts_/);
      const quarantined = db.prepare(`SELECT dummy FROM "${health.ok ? health.quarantinedTable : ""}"`).get() as { dummy: string };
      expect(quarantined.dummy).toBe("operator data");

      const docsStore = createDocsStore(docsDir);
      docsStore.writePage("notes/searchable", `---
title: Searchable
tags:
  - degraded
description: Degraded docs metadata remains usable.
---
# Searchable

This page contains xylophone content.`);
      const docsIndex = createDocsIndex(db, docsStore);
      const page = docsStore.readPage("notes/searchable");
      expect(page).not.toBeNull();
      const indexResult = docsIndex.indexPage(page!);

      expect(indexResult).toEqual({ indexed: true });
      expect(docsIndex.search("xylophone").results.map((result) => result.path)).toContain("notes/searchable");
      expect(docsIndex.queryByFolder("notes", undefined, undefined, 10, 0, true).entries).toHaveLength(1);
      expect(docsIndex.findDocsByTagNames(["degraded"])).toMatchObject([
        { path: "notes/searchable", matchedTags: ["degraded"] },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("self-heals leftover docs FTS shadow tables that block virtual table creation", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "docs-fts-shadow-test-"));
    tempDirs.push(dataDir);
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    legacyDb.exec("CREATE TABLE docs_fts_data(blocker TEXT)");
    legacyDb.exec("CREATE TABLE docs_fts_archive(note TEXT)");
    legacyDb.prepare("INSERT INTO docs_fts_archive(note) VALUES (?)").run("preserve me");
    legacyDb.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const db = openDatabase(dataDir);
    try {
      const health = getDocsFtsHealth(db);

      expect(health).toMatchObject({
        ok: true,
        status: "available",
        repaired: true,
        previousFailure: {
          detectedBy: "create_virtual_table",
        },
      });
      expect(health.ok ? health.repairMessage : "").toContain("dropped leftover docs FTS shadow table docs_fts_data");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'docs_fts_data'").get()).toBeTruthy();
      const archived = db.prepare("SELECT note FROM docs_fts_archive").get() as { note: string };
      expect(archived.note).toBe("preserve me");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("reports a clear unhealthy state when docs FTS repair fails", () => {
    const db = openMemoryDatabase();
    const realExec = db.exec.bind(db);
    db.exec("DROP TABLE docs_fts");
    db.exec("CREATE TABLE docs_fts(dummy TEXT)");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("ALTER TABLE docs_fts RENAME")) {
        throw new Error("rename blocked");
      }
      return realExec(sql);
    });

    const health = initializeDocsFts(db);

    expect(health).toMatchObject({
      ok: false,
      status: "unavailable",
      code: "docs_fts_init_failed",
      detectedBy: "repair",
    });
    expect(health.ok ? "" : health.cause).toContain("rename blocked");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[docs-fts]");
  });

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

  it("indexes folder index pages by folder path and resolves index aliases", () => {
    const { docsIndex, docsStore } = createIndexFixture();

    docsStore.writePage("guides/index", "# Guide Home\n\nFolder landing page.");
    docsIndex.reindex();

    const search = docsIndex.search("landing");
    expect(search.results.map((result) => result.path)).toContain("guides");
    expect(search.results.map((result) => result.path)).not.toContain("guides/index");
    expect(docsIndex.resolveWikilink("guides/index")).toEqual({
      path: "guides",
      title: "guides",
    });
  });

  it("does not index a colliding folder index when a leaf page owns the same path", () => {
    const { docsIndex, docsStore } = createIndexFixture();

    docsStore.writePage("guides", "# Leaf Guide\n\nLeaf-only content.");
    mkdirSync(join(docsStore.docsDir, "guides"), { recursive: true });
    writeFileSync(join(docsStore.docsDir, "guides", "index.md"), "# Folder Guide\n\nFolder-only content.", "utf-8");
    docsIndex.reindex();

    expect(docsIndex.search("Leaf-only").results.map((result) => result.path)).toContain("guides");
    expect(docsIndex.search("Folder-only").results.map((result) => result.path)).not.toContain("guides");
  });

  it("rejects unsafe DB folder query paths", () => {
    const { docsIndex } = createIndexFixture();

    expect(() => docsIndex.queryByFolder("C:foo")).toThrow(/Invalid folder/);
    expect(() => docsIndex.queryByFolder("\\\\server\\share")).toThrow(/Invalid folder/);
    expect(() => docsIndex.queryByFolder("..")).toThrow(/Invalid folder/);
  });

  it("returns description and exact matched tags for related docs", () => {
    const docsDir = mkdtempSync(join(tmpdir(), "docs-related-test-"));
    tempDirs.push(docsDir);

    const db = openMemoryDatabase();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("runbooks/deploy", `---
title: Deploy Runbook
tags:
  - deploy
  - infra
description: Restart services in the right order.
modified: 2026-04-20T00:00:00.000Z
---
# Deploy Runbook

This body should not be used as a manifest summary.
`);
    docsStore.writePage("notes/infrastructure", `---
title: Infrastructure Overview
tags:
  - infrastructure
description: This should not match infra exactly.
modified: 2026-04-19T00:00:00.000Z
---
# Infrastructure Overview
`);

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    const relatedDocs = docsIndex.findDocsByTagNames(["deploy", "infra"]);

    expect(relatedDocs).toHaveLength(1);
    expect(relatedDocs[0]).toMatchObject({
      path: "runbooks/deploy",
      title: "Deploy Runbook",
      tags: ["deploy", "infra"],
      folder: "runbooks",
      description: "Restart services in the right order.",
      matchedTags: ["deploy", "infra"],
    });
    expect(relatedDocs[0]?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns exact matches even when wildcard-like tag names would otherwise starve the limit", () => {
    const docsDir = mkdtempSync(join(tmpdir(), "docs-related-wildcard-test-"));
    tempDirs.push(docsDir);

    const db = openMemoryDatabase();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/exact-match", `---
title: Exact Match
tags:
  - ops_100%
description: Exact tag match.
---
# Exact Match
`);
    docsStore.writePage("notes/wildcard-candidate", `---
title: Wildcard Candidate
tags:
  - opsX100abc
description: Should not consume the only slot.
---
# Wildcard Candidate
`);

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    expect(docsIndex.findDocsByTagNames(["ops_100%"], 1)).toMatchObject([
      {
        path: "notes/exact-match",
        title: "Exact Match",
        matchedTags: ["ops_100%"],
      },
    ]);
  });

  it("keeps exact matches when crowded by newer substring near-matches", () => {
    const docsDir = mkdtempSync(join(tmpdir(), "docs-related-crowded-test-"));
    tempDirs.push(docsDir);

    const db = openMemoryDatabase();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/exact-infra", `---
title: Exact Infra
tags:
  - infra
description: Exact infra tag.
---
# Exact Infra
`);

    for (let i = 0; i < 25; i += 1) {
      docsStore.writePage(`notes/infrastructure-${i}`, `---
title: Infrastructure ${i}
tags:
  - infrastructure
description: Near match ${i}.
---
# Infrastructure ${i}
`);
    }

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    expect(docsIndex.findDocsByTagNames(["infra"], 20)).toContainEqual(expect.objectContaining({
      path: "notes/exact-infra",
      title: "Exact Infra",
      matchedTags: ["infra"],
    }));
  });

  it("preserves exact tag names that contain comma-space", () => {
    const docsDir = mkdtempSync(join(tmpdir(), "docs-related-comma-tag-test-"));
    tempDirs.push(docsDir);

    const db = openMemoryDatabase();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/comma-tag", `---
title: Comma Tag
tags:
  - "alpha, beta"
description: Exact comma tag.
---
# Comma Tag
`);
    docsStore.writePage("notes/split-tags", `---
title: Split Tags
tags:
  - alpha
  - beta
description: Separate tags only.
---
# Split Tags
`);

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    expect(docsIndex.findDocsByTagNames(["alpha, beta"])).toMatchObject([
      {
        path: "notes/comma-tag",
        title: "Comma Tag",
        tags: ["alpha, beta"],
        matchedTags: ["alpha, beta"],
      },
    ]);
  });

  it("matches related docs case-insensitively for Unicode-equivalent tags", () => {
    const docsDir = mkdtempSync(join(tmpdir(), "docs-related-unicode-tag-test-"));
    tempDirs.push(docsDir);

    const db = openMemoryDatabase();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/cafe", `---
title: Cafe Notes
tags:
  - STRASSE
description: Unicode tag match.
---
# Cafe Notes
`);

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    expect(docsIndex.findDocsByTagNames(["straße"])).toMatchObject([
      {
        path: "notes/cafe",
        title: "Cafe Notes",
        tags: ["STRASSE"],
        matchedTags: ["straße"],
      },
    ]);
  });

  it("does not treat accent variants as exact tag matches", () => {
    const docsDir = mkdtempSync(join(tmpdir(), "docs-related-accent-tag-test-"));
    tempDirs.push(docsDir);

    const db = openMemoryDatabase();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/resume", `---
title: Resume Notes
tags:
  - resume
description: Plain resume tag.
---
# Resume Notes
`);

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    expect(docsIndex.findDocsByTagNames(["résumé"])).toEqual([]);
  });
});

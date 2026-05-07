import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocsSnapshotStore, DocsSnapshotNotFoundError, DocsSnapshotValidationError } from "../docs-snapshot-store.js";
import { makeTestDir } from "./helpers.js";

function makeSnapshotStore(options: { maxSnapshots?: number } = {}) {
  const rootDir = makeTestDir("docs-snapshot-store");
  const docsDir = join(rootDir, "docs");
  const snapshotsDir = join(rootDir, "snapshots");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(snapshotsDir, { recursive: true });
  return {
    docsDir,
    snapshotsDir,
    store: createDocsSnapshotStore(docsDir, snapshotsDir, {
      appVersion: "test-version",
      maxSnapshots: options.maxSnapshots,
    }),
  };
}

describe("docs snapshot store", () => {
  it("creates a filesystem-safe snapshot with metadata and copied docs", () => {
    const { docsDir, snapshotsDir, store } = makeSnapshotStore();
    mkdirSync(join(docsDir, "projects"), { recursive: true });
    writeFileSync(join(docsDir, "projects", "alpha.md"), "# Alpha\n", "utf-8");

    const result = store.createSnapshot({ reason: "manual" });

    expect(result.created).toBe(true);
    expect(result.snapshot?.id).toMatch(/^\d{8}-\d{6}-\d{3}-[a-f0-9]{6}$/);
    expect(result.snapshot?.id).not.toContain(":");
    expect(result.snapshot).toMatchObject({
      reason: "manual",
      sourceDocsDir: docsDir,
      fileCount: 1,
      totalBytes: 8,
      appVersion: "test-version",
    });

    const snapshotId = result.snapshot!.id;
    expect(readFileSync(join(snapshotsDir, snapshotId, "docs", "projects", "alpha.md"), "utf-8")).toBe("# Alpha\n");
    const metadata = JSON.parse(readFileSync(join(snapshotsDir, snapshotId, "metadata.json"), "utf-8"));
    expect(metadata.contentHash).toBe(result.snapshot?.contentHash);
  });

  it("rejects overlapping docs and snapshot directories", () => {
    const rootDir = makeTestDir("docs-snapshot-overlap");
    const docsDir = join(rootDir, "docs");
    const snapshotsDir = join(rootDir, "snapshots");

    expect(() => createDocsSnapshotStore(docsDir, join(docsDir, "snapshots"))).toThrow(
      "Docs snapshots directory must not be inside docs directory",
    );
    expect(() => createDocsSnapshotStore(join(snapshotsDir, "docs"), snapshotsDir)).toThrow(
      "Docs directory must not be inside docs snapshots directory",
    );
  });

  it("skips recent unchanged snapshots but creates a new snapshot after content changes", () => {
    const { docsDir, store } = makeSnapshotStore();
    writeFileSync(join(docsDir, "note.md"), "# First\n", "utf-8");

    const first = store.createSnapshot({ reason: "manual" });
    const second = store.createSnapshot({
      reason: "pre-delete",
      skipIfRecentMs: 60_000,
      skipIfUnchanged: true,
    });

    expect(second).toMatchObject({
      created: false,
      skippedReason: "recent",
      snapshot: { id: first.snapshot?.id },
    });

    writeFileSync(join(docsDir, "note.md"), "# Changed\n", "utf-8");
    const third = store.createSnapshot({
      reason: "pre-delete",
      skipIfRecentMs: 60_000,
      skipIfUnchanged: true,
    });

    expect(third.created).toBe(true);
    expect(third.snapshot?.id).not.toBe(first.snapshot?.id);
  });

  it("restores a snapshot through a staged swap and creates a pre-restore snapshot", () => {
    const { docsDir, store } = makeSnapshotStore();
    writeFileSync(join(docsDir, "note.md"), "# Original\n", "utf-8");
    const snapshot = store.createSnapshot({ reason: "manual" }).snapshot!;

    writeFileSync(join(docsDir, "note.md"), "# Current\n", "utf-8");
    writeFileSync(join(docsDir, "extra.md"), "# Extra\n", "utf-8");

    const restore = store.restoreSnapshot(snapshot.id);

    expect(restore).toMatchObject({
      restoredFrom: { id: snapshot.id },
      fileCount: 1,
      totalBytes: 11,
    });
    expect(readFileSync(join(docsDir, "note.md"), "utf-8")).toBe("# Original\n");
    expect(existsSync(join(docsDir, "extra.md"))).toBe(false);
    expect(store.listSnapshots().some((entry) => entry.id === restore.preRestoreSnapshotId && entry.reason === "pre-restore")).toBe(true);
  });

  it("leaves live docs untouched when snapshot integrity validation fails", () => {
    const { docsDir, snapshotsDir, store } = makeSnapshotStore();
    writeFileSync(join(docsDir, "note.md"), "# Original\n", "utf-8");
    const snapshot = store.createSnapshot({ reason: "manual" }).snapshot!;
    writeFileSync(join(docsDir, "note.md"), "# Current\n", "utf-8");
    writeFileSync(join(snapshotsDir, snapshot.id, "docs", "note.md"), "# Corrupt\n", "utf-8");

    expect(() => store.restoreSnapshot(snapshot.id)).toThrow(DocsSnapshotValidationError);
    expect(readFileSync(join(docsDir, "note.md"), "utf-8")).toBe("# Current\n");
  });

  it("treats snapshots with corrupt metadata as missing", () => {
    const { docsDir, snapshotsDir, store } = makeSnapshotStore();
    writeFileSync(join(docsDir, "note.md"), "# Original\n", "utf-8");
    const snapshot = store.createSnapshot({ reason: "manual" }).snapshot!;
    writeFileSync(join(snapshotsDir, snapshot.id, "metadata.json"), "{not json", "utf-8");

    expect(() => store.restoreSnapshot(snapshot.id)).toThrow(DocsSnapshotNotFoundError);
  });

  it("prunes middle snapshots while preserving the oldest baseline and newest snapshot", () => {
    const { docsDir, store } = makeSnapshotStore({ maxSnapshots: 2 });

    writeFileSync(join(docsDir, "note.md"), "# One\n", "utf-8");
    const first = store.createSnapshot({ reason: "manual" }).snapshot!;
    writeFileSync(join(docsDir, "note.md"), "# Two\n", "utf-8");
    const second = store.createSnapshot({ reason: "manual" }).snapshot!;
    writeFileSync(join(docsDir, "note.md"), "# Three\n", "utf-8");
    const third = store.createSnapshot({ reason: "manual" }).snapshot!;

    const ids = store.listSnapshots().map((snapshot) => snapshot.id);
    expect(ids).toEqual([third.id, first.id]);
    expect(ids).not.toContain(second.id);
  });
});

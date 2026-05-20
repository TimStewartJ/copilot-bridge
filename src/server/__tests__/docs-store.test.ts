import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  createDocsStore,
  isResolvedPathWithinRoot,
  normalizeDocsPublicPath,
  resolveContainedDocsPath,
  resolveValidatedDocsPath,
} from "../docs-store.js";

const tempDirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "docs-store-test-"));
  tempDirs.push(dir);
  return createDocsStore(dir);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const unsafePathInputs = [
  ["drive-relative", "C:foo"],
  ["drive-absolute", "C:/foo"],
  ["UNC", "\\\\server\\share"],
  ["directory traversal", ".."],
] as const;

const pathApis = [
  { name: "posix", api: posix, root: posix.join("/", "docs-root") },
  { name: "win32", api: win32, root: win32.join("C:\\", "docs-root") },
] as const;

describe("docs store path hardening", () => {
  it.each(pathApis)("validates public docs paths with $name semantics", ({ api, root }) => {
    for (const [, input] of unsafePathInputs) {
      expect(() => resolveValidatedDocsPath(root, input, "page path", api)).toThrow(/Invalid page path/);
    }

    expect(resolveValidatedDocsPath(root, "notes/page.md", "page path", api))
      .toBe(api.resolve(root, "notes", "page"));
    expect(normalizeDocsPublicPath("notes\\page.md")).toBe("notes/page");
  });

  it.each(pathApis)("checks resolved containment with $name semantics", ({ api, root }) => {
    expect(isResolvedPathWithinRoot(root, api.resolve(root, "notes", "page.md"), api)).toBe(true);
    expect(isResolvedPathWithinRoot(root, api.resolve(root, "..", "escape.md"), api)).toBe(false);
    expect(() => resolveContainedDocsPath(root, [".."], ["escape.md"], "page path", api))
      .toThrow("Invalid page path: resolved path escapes docs root");
  });

  it.each(unsafePathInputs)("rejects unsafe page paths: %s", (_label, input) => {
    const store = makeStore();

    expect(() => normalizeDocsPublicPath(input)).toThrow(/Invalid page path/);
    expect(() => store.writePage(input, "# Unsafe")).toThrow(/Invalid page path/);
    expect(() => store.readPage(input)).toThrow(/Invalid page path/);
  });

  it.each(unsafePathInputs)("rejects unsafe DB collection paths: %s", (_label, input) => {
    const store = makeStore();

    expect(() => store.writeSchema(input, { name: "Unsafe", fields: [] })).toThrow(/Invalid folder/);
    expect(() => store.readSchema(input)).toThrow(/Invalid folder/);
    expect(() => store.listDbEntries(input)).toThrow(/Invalid folder/);
    expect(() => store.deleteFolder(input)).toThrow(/Invalid folder/);
  });

  it.each(["CON", "nul.md", "notes/foo.", "notes/foo ", "notes/foo:bar"])(
    "rejects Windows-reserved path forms: %s",
    (input) => {
      const store = makeStore();

      expect(() => store.writePage(input, "# Unsafe")).toThrow(/Invalid page path/);
      expect(() => store.writeSchema(input, { name: "Unsafe", fields: [] })).toThrow(/Invalid folder/);
    },
  );

  it("accepts valid relative page and DB collection paths", () => {
    const store = makeStore();

    const page = store.writePage("notes/valid-page.md", "# Valid Page");
    expect(page.path).toBe("notes/valid-page");
    expect(store.readPage("notes/valid-page")?.body).toBe("# Valid Page");

    store.writeSchema("areas/cooking/recipes", { name: "Recipes", fields: [] });
    const entry = store.addDbEntry("areas/cooking/recipes", { title: "Valid Entry" });
    expect(entry.path).toBe("areas/cooking/recipes/valid-entry");
    expect(store.listDbEntries("areas/cooking/recipes")).toHaveLength(1);
  });

  it("skips unsafe pre-existing disk entries during tree and index scans", () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = makeStore();

    writeFileSync(join(store.docsDir, "valid.md"), "# Valid", "utf-8");
    writeFileSync(join(store.docsDir, "CON.md"), "# Unsafe device name", "utf-8");
    mkdirSync(join(store.docsDir, "bad:folder"), { recursive: true });
    writeFileSync(join(store.docsDir, "bad:folder", "page.md"), "# Unsafe folder", "utf-8");

    expect(store.listTree().map((node) => node.path)).toEqual(["valid"]);
    expect(store.scanAllPages().map((page) => page.path)).toEqual(["valid"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping unsafe page path"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping unsafe folder"));
  });
});

describe("docs store folder index pages", () => {
  it("reads explicit folder index aliases with the folder path as canonical", () => {
    const store = makeStore();

    const written = store.writePage("guides/index", "# Guide Home\n\nFolder landing page.");
    const viaFolder = store.readPage("guides");
    const viaAlias = store.readPage("guides/index");

    expect(written.path).toBe("guides");
    expect(viaFolder?.path).toBe("guides");
    expect(viaAlias?.path).toBe("guides");
    expect(viaFolder?.folder).toBe("guides");
    expect(viaFolder?.isFolderIndex).toBe(true);
    expect(viaAlias?.body).toContain("Folder landing page.");
  });

  it("creates a folder index when writing a folder path that already exists", () => {
    const store = makeStore();

    store.writePage("guides/intro", "# Intro");
    const written = store.writePage("guides", "# Guide Home");
    const tree = store.listTree();
    const guides = tree.find((node) => node.path === "guides");

    expect(written.path).toBe("guides");
    expect(written.isFolderIndex).toBe(true);
    expect(guides).toMatchObject({ type: "folder", path: "guides", hasIndex: true });
    expect(guides?.children?.some((node) => node.path === "guides/index")).toBe(false);
  });

  it("keeps leaf pages authoritative when a leaf and folder index collide", () => {
    const store = makeStore();

    store.writePage("guides", "# Leaf Guide");
    mkdirSync(join(store.docsDir, "guides"), { recursive: true });
    writeFileSync(join(store.docsDir, "guides", "index.md"), "# Folder Guide", "utf-8");

    expect(store.readPage("guides")?.body).toBe("# Leaf Guide");
    expect(store.readPage("guides/index")?.body).toBe("# Folder Guide");
    expect(store.scanAllPages().filter((page) => page.path === "guides")).toHaveLength(1);
    expect(() => store.writePage("guides/index", "# New Folder Guide")).toThrow(
      'Cannot write folder index "guides/index" because page "guides" already exists',
    );
  });

  it("rejects raw writes to database collection folder indexes", () => {
    const store = makeStore();

    store.writeSchema("incidents", {
      name: "Incidents",
      fields: [{ name: "severity", type: "select", options: ["sev1"] }],
    });

    expect(() => store.writePage("incidents", "# Incident Index")).toThrow(
      'Cannot write raw content to DB folder "incidents"',
    );
    expect(() => store.writePage("incidents/index", "# Incident Index")).toThrow(
      'Cannot write raw content to DB folder "incidents"',
    );
  });
});

describe("docs store DB input normalization", () => {
  it("merges top-level fields when fields is empty", () => {
    const store = makeStore();

    const normalized = store.normalizeDbEntryInput({
      fields: {},
      title: "Recovered title",
      severity: "sev2",
      body: "Recovered body",
    }, "add", "incidents");

    expect(normalized.fields).toMatchObject({
      title: "Recovered title",
      severity: "sev2",
    });
    expect(normalized.body).toBe("Recovered body");
  });

  it("merges inferred frontmatter with explicit fields", () => {
    const store = makeStore();

    const normalized = store.normalizeDbEntryInput({
      fields: { severity: "sev2" },
      body: "---\ntitle: Frontmatter title\nseverity: sev1\ncreated: 2026-04-09T00:00:00.000Z\nmodified: 2026-04-09T00:00:00.000Z\n---\n\nRecovered body",
    }, "add", "incidents");

    expect(normalized.fields).toMatchObject({
      title: "Frontmatter title",
      severity: "sev2",
    });
    expect(normalized.fields).not.toHaveProperty("created");
    expect(normalized.fields).not.toHaveProperty("modified");
    expect(normalized.body).toBe("\nRecovered body");
  });

  it("allows body-only update payloads", () => {
    const store = makeStore();

    const normalized = store.normalizeDbEntryInput({
      body: "Updated body only",
    }, "update", "incidents");

    expect(normalized.fields).toEqual({});
    expect(normalized.body).toBe("Updated body only");
  });

  it("treats malformed frontmatter-like bodies as plain markdown when top-level fields are valid", () => {
    const store = makeStore();
    const rawBody = "---\nnot: [valid\n---\nBody text";

    const normalized = store.normalizeDbEntryInput({
      title: "Valid title",
      severity: "sev1",
      body: rawBody,
    }, "add", "incidents");

    expect(normalized.fields).toMatchObject({
      title: "Valid title",
      severity: "sev1",
    });
    expect(normalized.body).toBe(rawBody);
  });

  it("rejects dangerous field names", () => {
    const store = makeStore();

    expect(() => store.normalizeDbEntryInput(
      JSON.parse("{\"__proto__\":{\"title\":\"polluted\"},\"severity\":\"sev1\"}"),
      "add",
      "incidents",
    )).toThrow('Field name "__proto__" is not allowed');
  });
});

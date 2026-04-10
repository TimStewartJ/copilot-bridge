import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocsStore } from "../docs-store.js";

const tempDirs: string[] = [];

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "docs-store-test-"));
  tempDirs.push(dir);
  return createDocsStore(dir);
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
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

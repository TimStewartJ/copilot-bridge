import { describe, expect, it } from "vitest";
import { findUnsupportedSchemaKeywords, validateToolArguments } from "../agent-tools-mcp/validate-args.js";

describe("validateToolArguments", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer", minimum: 1 },
      ratio: { type: "number" },
      enabled: { type: "boolean" },
      mode: { type: "string", enum: ["fast", "slow"] },
      nullableId: { type: ["string", "null"] },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      tags: { type: "array", items: { type: "string" } },
      nested: {
        type: "object",
        properties: { inner: { type: "string" } },
        required: ["inner"],
      },
    },
    required: ["name"],
  };

  it("accepts arguments that satisfy the declared contract", () => {
    expect(validateToolArguments(schema, {
      name: "x",
      count: 2,
      ratio: 1.5,
      enabled: true,
      mode: "fast",
      nullableId: null,
      note: null,
      tags: ["a", "b"],
      nested: { inner: "y" },
    })).toBeUndefined();
  });

  it("ignores optional properties that are absent", () => {
    expect(validateToolArguments(schema, { name: "x" })).toBeUndefined();
  });

  it("rejects missing required properties", () => {
    expect(validateToolArguments(schema, { count: 1 })).toContain("missing required property: name");
  });

  it("treats an explicit undefined as absent for required checks", () => {
    expect(validateToolArguments(schema, { name: undefined })).toContain("missing required property: name");
  });

  it("rejects wrong primitive types", () => {
    expect(validateToolArguments(schema, { name: 5 })).toContain("name must be string");
    expect(validateToolArguments(schema, { name: "x", enabled: "yes" })).toContain("enabled must be boolean");
  });

  it("rejects fractional, unsafe and non-finite numbers", () => {
    expect(validateToolArguments(schema, { name: "x", count: 1.5 })).toContain("count must be integer");
    expect(validateToolArguments(schema, { name: "x", count: Number.MAX_SAFE_INTEGER + 2 })).toContain("count must be integer");
    expect(validateToolArguments(schema, { name: "x", ratio: Number.NaN })).toContain("ratio must be number");
    expect(validateToolArguments(schema, { name: "x", ratio: Number.POSITIVE_INFINITY })).toContain("ratio must be number");
  });

  it("enforces numeric bounds", () => {
    expect(validateToolArguments(schema, { name: "x", count: 0 })).toContain("count must be >= 1");
  });

  it("enforces enum membership", () => {
    expect(validateToolArguments(schema, { name: "x", mode: "medium" })).toContain("mode must be one of");
  });

  it("supports type arrays and anyOf null branches", () => {
    expect(validateToolArguments(schema, { name: "x", nullableId: 4 })).toContain("nullableId must be string or null");
    expect(validateToolArguments(schema, { name: "x", note: 4 })).toContain("note does not match any allowed shape");
  });

  it("validates array items and nested objects recursively", () => {
    expect(validateToolArguments(schema, { name: "x", tags: ["a", 2] })).toContain("tags[1] must be string");
    expect(validateToolArguments(schema, { name: "x", nested: {} })).toContain("nested is missing required property: inner");
    expect(validateToolArguments(schema, { name: "x", nested: { inner: 1 } })).toContain("nested.inner must be string");
  });

  it("rejects unknown properties only when additionalProperties is false", () => {
    const strict = { type: "object", properties: { intent: { type: "string" } }, required: ["intent"], additionalProperties: false };
    expect(validateToolArguments(strict, { intent: "a", extra: 1 })).toContain("unknown property: extra");
    expect(validateToolArguments(schema, { name: "x", extra: 1 })).toBeUndefined();
  });

  it("rejects non-object argument payloads", () => {
    expect(validateToolArguments(schema, "nope")).toContain("arguments must be an object");
    expect(validateToolArguments(schema, null)).toContain("arguments must be an object");
  });

  it("does not coerce numeric strings", () => {
    expect(validateToolArguments(schema, { name: "x", count: "2" })).toContain("count must be integer");
  });
});

describe("findUnsupportedSchemaKeywords", () => {
  it("reports keywords the validator does not implement", () => {
    const found = findUnsupportedSchemaKeywords({
      type: "object",
      properties: { a: { type: "string", pattern: "^x" } },
      oneOf: [{ type: "string" }],
    });
    expect(found).toContain("a.pattern");
    expect(found).toContain("oneOf");
  });

  it("reports type values the validator cannot check", () => {
    expect(findUnsupportedSchemaKeywords({
      type: "object",
      properties: { a: { type: "intger" }, b: { type: ["string", "date"] } },
    })).toEqual(["a.type:intger", "b.type:date"]);
  });

  it("accepts the supported subset", () => {
    expect(findUnsupportedSchemaKeywords({
      type: "object",
      properties: {
        a: { type: ["string", "null"], description: "d" },
        b: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        c: { type: "array", items: { type: "object", properties: { d: { type: "string" } }, required: ["d"] } },
      },
      required: ["a"],
      additionalProperties: false,
    })).toEqual([]);
  });
});

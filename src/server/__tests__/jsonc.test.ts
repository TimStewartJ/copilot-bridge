import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonComments } from "../jsonc.js";

describe("stripJsonComments", () => {
  it("keeps block comment markers inside strings", () => {
    const text = '{ "glob": "/* not a comment */" }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ glob: "/* not a comment */" });
  });

  it("handles escaped quotes before a comment marker", () => {
    const text = '{ "quote": "say \\"hi\\" // not a comment" } // trailing';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ quote: 'say "hi" // not a comment' });
  });

  it("does not treat an escaped backslash as escaping the closing quote", () => {
    const text = String.raw`{ "path": "C:\\", "n": 1 } // done`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ path: "C:\\", n: 1 });
  });

  it("removes block comments including multi-line ones", () => {
    const text = '{ /* one */ "a": 1, /* two\nlines */ "b": 2 }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1, b: 2 });
  });

  it("preserves newlines so parse error line numbers stay meaningful", () => {
    const text = "// header\n// header\n{}";
    expect(stripJsonComments(text)).toBe("\n\n{}");
  });

  it("removes trailing commas in objects and arrays", () => {
    const text = '{ "list": [1, 2, 3,], "nested": { "a": 1, }, }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ list: [1, 2, 3], nested: { a: 1 } });
  });

  it("keeps commas that belong to string values", () => {
    const text = '{ "a": "x,", "b": "y," }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: "x,", b: "y," });
  });
});

describe("parseJsonc", () => {
  it("still throws on genuinely malformed input", () => {
    expect(() => parseJsonc("{ not json")).toThrow();
  });
});

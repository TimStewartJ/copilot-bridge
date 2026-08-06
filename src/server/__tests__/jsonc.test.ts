import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonComments } from "../jsonc.js";

describe("stripJsonComments", () => {
  it("removes a leading line-comment header", () => {
    const text = [
      "// User settings belong in settings.json.",
      "// This file is managed automatically.",
      '{ "a": 1 }',
    ].join("\n");
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1 });
  });

  it("keeps comment markers that appear inside string values", () => {
    // The real Copilot config stores exactly this, and a naive // match truncates it.
    const text = '{ "host": "https://github.com", "path": "a//b" }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      host: "https://github.com",
      path: "a//b",
    });
  });

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

  it("leaves plain JSON untouched", () => {
    const text = '{"a":1,"b":[2,3]}';
    expect(stripJsonComments(text)).toBe(text);
  });
});

describe("parseJsonc", () => {
  it("parses a Copilot-style config with a comment header", () => {
    const text = [
      "// User settings belong in settings.json.",
      "// This file is managed automatically.",
      "{",
      '  "loggedInUsers": [',
      "    {",
      '      "host": "https://github.com",',
      '      "login": "someone_example"',
      "    }",
      "  ],",
      '  "lastLoggedInUser": { "host": "https://github.com", "login": "someone_example" }',
      "}",
    ].join("\n");

    expect(parseJsonc(text)).toEqual({
      loggedInUsers: [{ host: "https://github.com", login: "someone_example" }],
      lastLoggedInUser: { host: "https://github.com", login: "someone_example" },
    });
  });

  it("still throws on genuinely malformed input", () => {
    expect(() => parseJsonc("{ not json")).toThrow();
  });
});

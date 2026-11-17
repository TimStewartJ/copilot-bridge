import { describe, expect, it } from "vitest";
import { findCommentProblems } from "../comment-audit.js";

const long = "x".repeat(96);

describe("comment audit", () => {
  it.each([
    ["one-line comments with code between", "// a\nconst a = 1;\n/** b */\nconst b = 2;", []],
    ["a comment line over 100 columns", `  // ${long}\nf();`, [{ line: 1, problem: "too-long" }]],
    ["a trailing comment that makes the line too long", `const value = 1; // ${long}`, [{ line: 1, problem: "too-long" }]],
    ["a block comment over several lines", "/**\n * a\n */\nf();", [{ line: 1, problem: "multi-line" }]],
    ["stacked line comments", "// a\n// b\nf();", [{ line: 2, problem: "stacked" }]],
    ["a comment under a trailing comment", "f(); // a\n// b\ng();", [{ line: 2, problem: "stacked" }]],
    ["two comments on one line", "/** a */ // b\nf();", [{ line: 1, problem: "stacked" }]],
    ["trailing comments on consecutive code lines", "f(); // a\ng(); // b", []],
    ["a blank line or code after a trailing comment", "f(); // a\n\n// b\ntry { g(); } catch { /* c */ }\n// d\nh();", []],
    ["comments split only by a blank line", "// a\n\n// b\nf();", [{ line: 3, problem: "stacked" }]],
    ["a directive under a comment", "// why\n// @ts-expect-error\nf();", []],
    ["stacked JSX comments", "const v = (\n  <div>\n    {/* a */}\n    {/* b */}\n  </div>\n);", [{ line: 4, problem: "stacked" }]],
    ["comment-like text inside JSX", "const v = (\n  <p>\n    see /* a */ here\n    and // b\n  </p>\n);", []],
    ["a regex and a string that look like comments", "const r = /^staging\\//;\nconst s = \"// not\";\n// real\nf();", []],
  ])("%s", (_name, code, expected) => {
    expect(findCommentProblems("example.tsx", code)).toEqual(expected);
  });
});

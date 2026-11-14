import { describe, expect, it } from "vitest";
import { findPhraseChecks } from "../agent-text-audit.js";

const check = (code: string) => findPhraseChecks("example.ts", code).map(({ line, source, invalid }) => ({
  line,
  ...(source ? { source } : {}),
  ...(invalid ? { invalid: invalid.split(";")[0] } : {}),
}));

describe("agent text audit", () => {
  it.each([
    ["a word list", "if (/\\b(?:done|finished)\\b/i.test(reply)) stop();", [{ line: 1 }]],
    ["a phrase in a regex", "const offer = /read (?:you )?the whole thing/i.test(text);", [{ line: 1 }]],
    ["a case-sensitive word list", "if (/done|finished/.test(reply)) stop();", [{ line: 1 }]],
    ["a searched phrase", "if (reply.includes(\"all done\")) stop();", [{ line: 1 }]],
    ["a compared phrase", "if (reply === \"all done\") stop();", [{ line: 1 }]],
    ["an explained check", "// agent-text-audit: error (SQLite)\nif (/duplicate column name/i.test(message)) skip();", [{ line: 2, source: "error" }]],
    ["agent text as a source", "// agent-text-audit: agent (model reply)\nif (/\\bdone\\b/i.test(reply)) stop();", [{ line: 2, invalid: "text a model wrote must not be matched against words" }]],
    ["a file of one source", "// agent-text-audit-file: tool-output (CLI output)\nif (out.includes(\"not found\")) fail();", [{ line: 2, source: "tool-output" }]],
    ["a source that is not one", "// agent-text-audit: constructor\nif (/\\bdone\\b/i.test(reply)) stop();", [{ line: 2, invalid: "unknown source \"constructor\"" }]],
    ["a directive inside a string", "const hint = \"agent-text-audit: error\"; if (/\\bdone\\b/i.test(reply)) stop();", [{ line: 1 }]],
    ["formats, enums and identifiers", "if (/^https?:\\/\\//i.test(url) || /\\.(png|jpe?g)$/i.test(name) || /task_(?:create|update)/.test(tool) || status === \"done\") show();", []],
  ])("%s", (_name, code, expected) => {
    expect(check(code)).toEqual(expected);
  });
});

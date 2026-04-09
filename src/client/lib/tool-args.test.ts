import { describe, expect, it } from "vitest";
import { formatToolArgsDetails, hasToolArgs, summarizeToolArgs } from "./tool-args";

describe("tool arg helpers", () => {
  it("summarizes freeform string arguments without splitting characters", () => {
    expect(summarizeToolArgs("*** Begin Patch\n*** Update File: foo.ts")).toBe("*** Begin Patch\n*** Update File: foo.ts");
  });

  it("keeps object-backed summaries focused on common keys", () => {
    expect(summarizeToolArgs({ command: "npm run build -- --watch" }, { maxLength: 12 })).toBe("npm run b...");
    expect(summarizeToolArgs({ path: "/tmp/a/b/c/file.ts" })).toBe("b/c/file.ts");
  });

  it("formats detail output for both strings and objects", () => {
    expect(formatToolArgsDetails("line 1\nline 2")).toBe("line 1\nline 2");
    expect(formatToolArgsDetails({ shellId: "123", delay: 10 })).toBe('{\n  "shellId": "123",\n  "delay": 10\n}');
  });

  it("detects whether any arguments are present", () => {
    expect(hasToolArgs(undefined)).toBe(false);
    expect(hasToolArgs("")).toBe(false);
    expect(hasToolArgs([])).toBe(false);
    expect(hasToolArgs({})).toBe(false);
    expect(hasToolArgs(false)).toBe(true);
    expect(hasToolArgs("patch")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { sh } from "../shell-command.js";

describe("sh", () => {
  it("refuses shell text built from a value, at compile time and at run time", () => {
    const branch = "feature/x & echo hi";
    // @ts-expect-error A value in shell text does not compile; pass it as an argument with commandLine().
    expect(() => sh`git branch ${branch}`).toThrow(TypeError);
  });
});

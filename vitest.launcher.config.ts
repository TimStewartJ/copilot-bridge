import { defineProject } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "launcher",
    include: ["src/launcher*.test.ts"],
    sequence: {
      groupOrder: process.platform === "win32" ? 1 : 0,
    },
  },
});

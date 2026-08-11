import { defineProject } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "launcher-integration",
    include: ["src/launcher-windows-supervision.test.ts"],
    testTimeout: 60_000,
    sequence: {
      groupOrder: process.platform === "win32" ? 2 : 0,
    },
  },
});

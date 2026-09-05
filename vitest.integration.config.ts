import { defineProject } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "integration",
    include: ["src/integration/**/*.test.ts"],
    pool: "threads",
    fileParallelism: process.platform !== "win32",
    maxWorkers: process.platform === "win32" ? 1 : undefined,
    testTimeout: 60_000,
    sequence: {
      groupOrder: process.platform === "win32" ? 2 : 0,
    },
  },
});

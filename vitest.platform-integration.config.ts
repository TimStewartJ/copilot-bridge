import { defineProject } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "platform-integration",
    include: ["src/server/__tests__/platform-process-tree.windows.test.ts"],
    sequence: {
      groupOrder: process.platform === "win32" ? 3 : 0,
    },
  },
});

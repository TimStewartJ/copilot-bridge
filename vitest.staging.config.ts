import { defineProject } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "staging",
    include: [
      "src/server/__tests__/pre-deploy-checkpoint.test.ts",
      "src/server/__tests__/staging-preview-backend.test.ts",
      "src/server/__tests__/staging-tools.test.ts",
    ],
  },
});

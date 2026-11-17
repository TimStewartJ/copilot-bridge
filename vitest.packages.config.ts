import { defineProject } from "vitest/config";
import { NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

// Packages publish alone, so no Bridge setup file; their *.native tests run in native.
const { setupFiles: _bridgeSetupFiles, ...standaloneTestConfig } = sharedTestConfig;

export default defineProject({
  test: {
    ...standaloneTestConfig,
    name: "packages",
    include: ["src/packages/*/test/**/*.test.ts"],
    exclude: [NATIVE_TEST_FILES],
    pool: "threads",
  },
});

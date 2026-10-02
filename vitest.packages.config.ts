import { defineProject } from "vitest/config";
import { NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

// In-tree packages (src/packages/*) are published on their own, so their tests run without the
// Bridge's setup file: nothing in a package may depend on the rest of the repository. Their
// *.native.test.ts files still run in the native project, which schedules real process work.
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

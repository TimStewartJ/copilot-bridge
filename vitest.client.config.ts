import { defineProject } from "vitest/config";
import { NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "client",
    include: ["src/client/**/*.test.ts"],
    exclude: [NATIVE_TEST_FILES],
    // Safe because React DOM tests use src/client/test-react-harness.ts, which owns per-file setup.
    fileParallelism: true,
  },
});

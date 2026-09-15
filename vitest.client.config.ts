import { defineProject } from "vitest/config";
import { NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "client",
    include: ["src/client/**/*.test.ts"],
    exclude: [NATIVE_TEST_FILES],
    // Client React DOM tests are expected to use src/client/test-react-harness.ts
    // so each file owns DOM setup, React act boundaries, and root cleanup.
    fileParallelism: true,
  },
});

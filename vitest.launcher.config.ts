import { defineProject } from "vitest/config";
import { NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    name: "launcher",
    include: ["src/launcher*.test.ts"],
    exclude: [NATIVE_TEST_FILES],
  },
});

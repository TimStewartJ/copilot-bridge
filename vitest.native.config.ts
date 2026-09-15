import { defineProject } from "vitest/config";
import { nativeProjectScheduling, NATIVE_TEST_FILES, sharedTestConfig } from "./vitest.shared.js";

export default defineProject({
  test: {
    ...sharedTestConfig,
    ...nativeProjectScheduling,
    name: "native",
    include: [NATIVE_TEST_FILES],
  },
});

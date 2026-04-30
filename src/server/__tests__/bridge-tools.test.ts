import { describe, expect, it } from "vitest";
import { createBridgeTools } from "../bridge-tools.js";
import { createTestApp, makeTestRuntimePaths } from "./helpers.js";

describe("createBridgeTools", () => {
  it("hides git-backed tools in release mode while keeping restart available", () => {
    const runtimePaths = makeTestRuntimePaths("release-tools", { distributionMode: "release" });
    const { ctx } = createTestApp({ runtimePaths });

    const toolNames = new Set(createBridgeTools(ctx).map((tool) => tool.name));

    expect(toolNames.has("self_restart")).toBe(true);
    expect(toolNames.has("self_update")).toBe(false);
    expect(toolNames.has("staging_init")).toBe(false);
    expect(toolNames.has("staging_deploy")).toBe(false);
  });
});

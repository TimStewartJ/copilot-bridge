import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBridgeTools } from "../session-manager.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./helpers.js";

function createInvocation() {
  return {
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    toolCallId: "tool-send-attachment",
    toolName: "send_attachment",
    arguments: {},
  };
}

describe("send_attachment tool", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes an existing file and returns markdown for the assistant to echo", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-tool-home-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "bridge-tool-src-"));
    tempDirs.push(copilotHome, sourceDir);
    const sourcePath = join(sourceDir, "report.csv");
    writeFileSync(sourcePath, "total\n3\n");

    const { ctx } = createTestApp({ copilotHome });
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "send_attachment");
    if (!tool) throw new Error("send_attachment tool not found");

    const result = await tool.handler({ path: sourcePath }, createInvocation());

    expect(result).toMatchObject({
      success: true,
      attachmentId: "report.csv",
      displayName: "report.csv",
      mimeType: "text/csv",
      url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/report.csv",
      markdown: "[Download report.csv](/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/report.csv)",
    });
    expect(readFileSync(join(copilotHome, "session-state", createInvocation().sessionId, "files", "outgoing", "report.csv"), "utf-8")).toBe("total\n3\n");
  });

  it("requires displayName when publishing inline content", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-tool-home-"));
    tempDirs.push(copilotHome);

    const { ctx } = createTestApp({ copilotHome });
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "send_attachment");
    if (!tool) throw new Error("send_attachment tool not found");

    await expect(tool.handler({ content: "hello" }, createInvocation()))
      .resolves.toEqual(toolFailure("displayName is required when content is provided"));
  });

  it("publishes inline content when displayName is provided", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-tool-home-"));
    tempDirs.push(copilotHome);

    const { ctx } = createTestApp({ copilotHome });
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "send_attachment");
    if (!tool) throw new Error("send_attachment tool not found");

    const result = await tool.handler({ content: "# Hi\n", displayName: "note.md" }, createInvocation());

    expect(result).toMatchObject({
      success: true,
      attachmentId: "note.md",
      displayName: "note.md",
      markdown: "[Download note.md](/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/note.md)",
    });
  });

  it("uses the context apiBasePath when generating attachment links", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-tool-home-"));
    tempDirs.push(copilotHome);

    const { ctx } = createTestApp({ copilotHome, apiBasePath: "/staging/preview-123/api" });
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "send_attachment");
    if (!tool) throw new Error("send_attachment tool not found");

    const result = await tool.handler({ content: "hello", displayName: "note.md" }, createInvocation());

    expect(result).toMatchObject({
      success: true,
      url: "/staging/preview-123/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/note.md",
      markdown: "[Download note.md](/staging/preview-123/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/note.md)",
    });
  });

  it("derives the staging apiBasePath when running in a staged preview context", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-tool-home-"));
    tempDirs.push(copilotHome);

    const { ctx } = createTestApp({
      copilotHome,
      apiBasePath: undefined,
      isStaging: true,
      runtimePaths: {
        demoMode: false,
        dataDir: join(tmpdir(), "preview-xyz", "data"),
        docsDir: join(tmpdir(), "preview-xyz", "data", "docs"),
        copilotHome,
        env: {},
      },
    });
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "send_attachment");
    if (!tool) throw new Error("send_attachment tool not found");

    const result = await tool.handler({ content: "hello", displayName: "note.md" }, createInvocation());

    expect(result).toMatchObject({
      success: true,
      url: "/staging/preview-xyz/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/note.md",
      markdown: "[Download note.md](/staging/preview-xyz/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/attachments/note.md)",
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { resolveVisualArtifactForOwner, sessionVisualOwner } from "../visual-artifacts.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./test-app.js";

function createInvocation() {
  return {
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    toolCallId: "tool-publish-visual",
    toolName: "publish_visual",
    arguments: {},
  };
}

const VALID_SPEC = JSON.stringify({
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  mark: "bar",
  data: { values: [{ a: "A", b: 28 }, { a: "B", b: 55 }] },
  encoding: {
    x: { field: "a", type: "ordinal" },
    y: { field: "b", type: "quantitative" },
  },
});

describe("publish_visual tool", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), "bridge-pub-visual-"));
    tempDirs.push(dir);
    return dir;
  }

  it("publishes a file-backed image card with its inferred media type", async () => {
    const copilotHome = makeTmpDir();
    const srcDir = makeTmpDir();
    const srcPath = join(srcDir, "chart.jpg");
    writeFileSync(srcPath, Buffer.from([0xff, 0xd8, 0xff]));

    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const result: any = await tool.handler(
      { kind: "image", title: "My Chart", path: srcPath },
      createInvocation(),
    );

    expect(result.success).toBe(true);
    expect(result.__kind).toBe("visual.published");
    expect(result.kind).toBe("image");
    expect(result.title).toBe("My Chart");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.url).toMatch(/\/visuals\//);
    expect(result.downloadUrl).toMatch(/\/download/);
    expect(typeof result.artifactId).toBe("string");
    expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.source).toBeUndefined();
    expect(result.message).toBeUndefined();
    expect(result.content).toBe('Visual artifact "My Chart" published as a visual card.');
  });

  it("publishes an image from base64 content", async () => {
    const copilotHome = makeTmpDir();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const result: any = await tool.handler(
      {
        kind: "image",
        title: "Inline",
        content: pngBytes.toString("base64"),
        mimeType: "image/png",
        displayName: "inline.png",
      },
      createInvocation(),
    );

    expect(result.success).toBe(true);
    expect(result.__kind).toBe("visual.published");
    expect(result.displayName).toBe("inline.png");
    expect(result.size).toBe(pngBytes.length);
  });

  it("returns toolFailure when kind is unsupported", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    for (const kind of ["svg", "html"]) {
      const result = await tool.handler({ kind, title: "Page", content: "<p>Preview</p>" }, createInvocation());
      expect(result).toMatchObject({ resultType: "failure", textResultForLlm: expect.stringMatching(/kind must be one of/) });
    }
  });

  it("publishes a Mermaid card backed by the saved diagram", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const source = "graph TD\n  A-->B";
    const bus = ctx.eventBusRegistry.getOrCreateBus(createInvocation().sessionId);
    const result: any = await tool.handler(
      { kind: "mermaid", title: "My Flow", content: source },
      createInvocation(),
    );

    expect(result.success).toBe(true);
    expect(result.__kind).toBe("visual.published");
    expect(result.kind).toBe("mermaid");
    expect(result.title).toBe("My Flow");
    expect(result.mimeType).toBe("text/vnd.mermaid");
    expect(result.source).toBeUndefined();
    expect(result.message).toBeUndefined();
    expect(result.content).toBe('Mermaid diagram "My Flow" published as a visual card.');
    expect(result.url).toMatch(/\/visuals\//);
    expect(result.downloadUrl).toMatch(/\/download/);
    expect(typeof result.artifactId).toBe("string");
    expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(bus.getSnapshot().liveVisuals).toMatchObject([{ artifactId: result.artifactId, source }]);
    expect(result.size).toBe(Buffer.byteLength(source));
    const resolved = resolveVisualArtifactForOwner(copilotHome, sessionVisualOwner(createInvocation().sessionId), result.artifactId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({ mimeType: result.mimeType, displayName: expect.stringMatching(/\.mmd$/) });
    expect(readFileSync(resolved.value.filePath, "utf8")).toBe(source);
  });

  it("publishes a vega-lite spec and returns structured visual result", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const result: any = await tool.handler(
      { kind: "vega-lite", title: "My Chart", content: VALID_SPEC },
      createInvocation(),
    );

    expect(result.success).toBe(true);
    expect(result.__kind).toBe("visual.published");
    expect(result.kind).toBe("vega-lite");
    expect(result.title).toBe("My Chart");
    expect(result.mimeType).toBe("application/vnd.vegalite+json");
    expect(result.url).toMatch(/\/visuals\//);
    expect(result.downloadUrl).toMatch(/\/download/);
    expect(typeof result.artifactId).toBe("string");
    expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.source).toBeUndefined();
    expect(result.message).toBeUndefined();
    expect(result.content).toBe('Vega-Lite chart "My Chart" published as a visual card.');
  });

  it("returns toolFailure for empty vega-lite content", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const result = await tool.handler(
      { kind: "vega-lite", title: "Empty", content: "   " },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/empty/i);
  });

  it("returns toolFailure for invalid JSON vega-lite content", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const result = await tool.handler(
      { kind: "vega-lite", title: "Bad JSON", content: "{ not valid json" },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/not valid JSON/i);
  });

  it("returns toolFailure when vega-lite spec is too large", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    // Build a spec that exceeds 500KB
    const bigValues = Array.from({ length: 20_000 }, (_, i) => ({ a: `item-${i}`, b: i }));
    const bigSpec = JSON.stringify({ mark: "point", data: { values: bigValues } });

    const result = await tool.handler(
      { kind: "vega-lite", title: "Huge", content: bigSpec },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/size limit/i);
  });

  it("returns toolFailure when vega-lite spec is too deeply nested", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    // Build a 25-deep nested object
    let deep: any = { val: 1 };
    for (let i = 0; i < 25; i++) deep = { nested: deep };
    const result = await tool.handler(
      { kind: "vega-lite", title: "Deep", content: JSON.stringify(deep) },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/depth/i);
  });

  it("returns toolFailure when spec uses data.url at top level", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const networkSpec = JSON.stringify({
      mark: "line",
      data: { url: "https://example.com/data.csv" },
      encoding: { x: { field: "x" }, y: { field: "y" } },
    });

    const result = await tool.handler(
      { kind: "vega-lite", title: "Network", content: networkSpec },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/data\.url/i);
  });

  it("returns toolFailure when a layer view uses data.url", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const layerSpec = JSON.stringify({
      layer: [
        {
          mark: "bar",
          data: { url: "https://example.com/layer.csv" },
          encoding: { x: { field: "x" }, y: { field: "y" } },
        },
      ],
    });

    const result = await tool.handler(
      { kind: "vega-lite", title: "Layer Net", content: layerSpec },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/data\.url/i);
  });

  it("returns toolFailure when a lookup transform uses data.url", async () => {
    const copilotHome = makeTmpDir();
    const { ctx } = createTestApp({ copilotHome });
    const tool = getBridgeToolDefinitions(ctx).find((t) => t.name === "publish_visual");
    if (!tool) throw new Error("publish_visual tool not found");

    const lookupSpec = JSON.stringify({
      data: { values: [{ k: 1, value: 10 }] },
      transform: [
        {
          lookup: "k",
          from: {
            data: { url: "https://example.com/lookup.json" },
            key: "k",
            fields: ["label"],
          },
        },
      ],
      mark: "point",
      encoding: { x: { field: "value" }, y: { field: "label" } },
    });

    const result = await tool.handler(
      { kind: "vega-lite", title: "Lookup Net", content: lookupSpec },
      createInvocation(),
    );

    expect((result as any).resultType).toBe("failure");
    expect((result as any).textResultForLlm).toMatch(/data\.url/i);
  });
});

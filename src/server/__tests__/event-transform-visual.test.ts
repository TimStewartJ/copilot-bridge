import { describe, expect, it } from "vitest";
import { transformEventsToMessages } from "../event-transform.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const SAMPLE_VISUAL_RESULT = {
  __kind: "visual.published",
  success: true,
  artifactId: "550e8400-e29b-41d4-a716-446655440000",
  kind: "image",
  title: "My Chart",
  displayName: "chart.png",
  mimeType: "image/png",
  size: 1024,
  url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/550e8400-e29b-41d4-a716-446655440000",
  downloadUrl: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/550e8400-e29b-41d4-a716-446655440000/download",
  caption: "Chart caption",
  altText: "chart alt",
  content: "Visual artifact published",
};

function publication(toolCallId: string, second: number, kind: string, title: string, result: unknown, success = true) {
  const at = (offset: number) => `2026-04-10T10:00:${String(second + offset).padStart(2, "0")}.000Z`;
  return [
    { type: "tool.execution_start", timestamp: at(0), data: { toolCallId, toolName: "publish_visual", arguments: { kind, title } } },
    { type: "tool.execution_complete", timestamp: at(1), data: { toolCallId, success, result } },
  ];
}

function makePublishVisualEvents(opts: { success?: boolean; result?: unknown } = {}) {
  return [
    { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Show me a chart" } },
    ...publication("tc-publish-1", 1, "image", "My Chart", opts.result ?? SAMPLE_VISUAL_RESULT, opts.success),
  ];
}

function visualResult(artifactId: string, kind: string, title: string, fields: Record<string, unknown> = {}) {
  const url = `/api/sessions/${SESSION_ID}/visuals/${artifactId}`;
  return { __kind: "visual.published", success: true, artifactId, kind, title, url, downloadUrl: `${url}/download`, ...fields };
}

describe("event-transform: visual entries", () => {
  it("does not emit a visual entry when publish_visual fails", () => {
    const events = makePublishVisualEvents({
      success: false,
      result: { textResultForLlm: "Failed to publish", resultType: "failure" },
    });
    const entries = transformEventsToMessages(events, SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(0);
  });

  it("does not emit a visual entry when result has no __kind", () => {
    const events = makePublishVisualEvents({
      result: { success: true, message: "No kind here" },
    });
    const entries = transformEventsToMessages(events, SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(0);
  });

  it("does not emit a visual entry when the result URL contains the artifactId only in a query string, fragment, or other origin", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440000";
    const cases = [
      {
        label: "query string",
        url: `/api/admin/dangerous?fake=/sessions/${SESSION_ID}/visuals/${artifactId}`,
      },
      {
        label: "fragment",
        url: `/api/admin/dangerous#/sessions/${SESSION_ID}/visuals/${artifactId}`,
      },
      {
        // URL parser may resolve /\\ as a different origin
        label: "other origin",
        url: `/\\evil.example/api/sessions/${SESSION_ID}/visuals/${artifactId}`,
      },
    ];
    for (const { label, url } of cases) {
      const entries = transformEventsToMessages(
        makePublishVisualEvents({ result: { ...SAMPLE_VISUAL_RESULT, artifactId, url } }),
        SESSION_ID,
      );
      expect(entries.filter((e) => e.type === "visual"), label).toHaveLength(0);
    }
  });

  it("does not emit a visual entry for other tools with __kind field", () => {
    const events = [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tc-other",
          toolName: "send_attachment",
          arguments: {},
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: {
          toolCallId: "tc-other",
          success: true,
          result: { __kind: "visual.published", artifactId: "550e8400-e29b-41d4-a716-446655440000", url: "/api/x" },
        },
      },
    ];
    const entries = transformEventsToMessages(events, SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(0);
  });

  it("replays direct, serialized and wrapped publications after their own calls", () => {
    const second = visualResult("660e8400-e29b-41d4-a716-446655440000", "image", "Second", { mimeType: "image/jpeg" });
    const third = visualResult("880e8400-e29b-41d4-a716-446655440000", "image", "Third");
    const entries = transformEventsToMessages([
      ...makePublishVisualEvents(),
      ...publication("tc-second", 3, "image", "Second", JSON.stringify(second)),
      ...publication("tc-third", 5, "image", "Third", { content: JSON.stringify(third), detailedContent: "Publication saved" }),
      { type: "assistant.message", timestamp: "2026-04-10T10:00:07.000Z", data: { content: "Here are your charts." } },
    ], SESSION_ID);

    expect(entries).toMatchObject([
      { type: "message", role: "user", content: "Show me a chart" },
      { type: "tool", toolCall: { toolCallId: "tc-publish-1", name: "publish_visual", success: true } },
      { type: "visual", visual: {
        artifactId: "550e8400-e29b-41d4-a716-446655440000", kind: "image", title: "My Chart", mimeType: "image/png",
        url: SAMPLE_VISUAL_RESULT.url, downloadUrl: SAMPLE_VISUAL_RESULT.downloadUrl, caption: "Chart caption", altText: "chart alt",
      } },
      { type: "tool", toolCall: { toolCallId: "tc-second" } },
      { type: "visual", visual: { artifactId: "660e8400-e29b-41d4-a716-446655440000", mimeType: "image/jpeg" } },
      { type: "tool", toolCall: { toolCallId: "tc-third" } },
      { type: "visual", visual: { artifactId: "880e8400-e29b-41d4-a716-446655440000" } },
      { type: "message", role: "assistant", content: "Here are your charts." },
    ]);
    expect(entries[2].visual?.source).toBeUndefined();
  });
});

describe("event-transform: published document formats", () => {
  it("keeps diagram, chart and HTML publications metadata-only", () => {
    const diagram = "770e8400-e29b-41d4-a716-446655440000";
    const chart = "990e8400-e29b-41d4-a716-446655440000";
    const page = "aa0e8400-e29b-41d4-a716-446655440000";
    const entries = transformEventsToMessages([
      ...publication("diagram", 1, "mermaid", "Architecture", visualResult(diagram, "mermaid", "Architecture", { mimeType: "text/vnd.mermaid", source: "graph TD; A-->B" })),
      ...publication("chart", 3, "vega-lite", "Counts", visualResult(chart, "vega-lite", "Counts", { mimeType: "application/vnd.vegalite+json", source: '{"mark":"bar"}' })),
      ...publication("page", 5, "html", "Report", visualResult(page, "html", "Report", { mimeType: "text/html; charset=utf-8", source: "<p>Report</p>" })),
    ], SESSION_ID);
    const visuals = entries.filter((entry) => entry.type === "visual").map((entry) => entry.visual);
    expect(visuals).toMatchObject([
      { artifactId: diagram, kind: "mermaid", title: "Architecture", mimeType: "text/vnd.mermaid" },
      { artifactId: chart, kind: "vega-lite", title: "Counts", mimeType: "application/vnd.vegalite+json" },
      { artifactId: page, kind: "html", title: "Report", mimeType: "text/html; charset=utf-8" },
    ]);
    expect(visuals.map((visual) => visual?.source)).toEqual([undefined, undefined, undefined]);
  });

  it("uses the format of each publication when its MIME type is absent", () => {
    const chart = "990e8400-e29b-41d4-a716-446655440000";
    const page = "aa0e8400-e29b-41d4-a716-446655440001";
    const entries = transformEventsToMessages([
      ...publication("chart", 1, "vega-lite", "Counts", visualResult(chart, "vega-lite", "Counts")),
      ...publication("page", 3, "html", "Report", visualResult(page, "html", "Report")),
    ], SESSION_ID);
    expect(entries.filter((entry) => entry.type === "visual").map((entry) => [entry.visual?.artifactId, entry.visual?.mimeType])).toEqual([
      [chart, "application/vnd.vegalite+json"], [page, "text/html"],
    ]);
  });
});

describe("event-transform: generated images", () => {
  const PNG_BASE64 = Buffer.from("not really a png, ten bytes long").toString("base64");
  const savedIn = (sessionId: string, fileName = "image-0a1b2c3d4e5f6071.png") =>
    `C:\\Users\\someone\\.copilot\\session-state\\${sessionId}\\images\\${fileName}`;

  function imageEvents(options: { args?: Record<string, unknown>; savedPath?: string; success?: boolean; toolCallId?: string; second?: number } = {}) {
    const toolCallId = options.toolCallId ?? "tc-image";
    const at = (offset: number) => `2026-04-10T10:00:${String((options.second ?? 1) + offset).padStart(2, "0")}.000Z`;
    return [
      {
        type: "tool.execution_start",
        timestamp: at(0),
        data: { toolCallId, toolName: "image_generation", arguments: options.args ?? { prompt: "A small bridge at dusk" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: at(8),
        data: {
          toolCallId,
          success: options.success ?? true,
          result: {
            content: "Image generated successfully.",
            contents: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
            structuredContent: {
              imageGeneration: {
                images: [{
                  contentIndex: 0,
                  mimeType: "image/png",
                  width: 1024,
                  height: 1024,
                  imageId: "sha256:abc",
                  savedPath: options.savedPath ?? savedIn(SESSION_ID),
                }],
              },
            },
          },
        },
      },
    ];
  }

  it("shows a generated image and its edit after their own tools", () => {
    const original = "image-0a1b2c3d4e5f6071.png";
    const edit = "image-edited.png";
    const entries = transformEventsToMessages([
      ...imageEvents({ toolCallId: "draw", savedPath: savedIn(SESSION_ID, original), args: { prompt: "A bridge at dusk" } }),
      ...imageEvents({ toolCallId: "edit", second: 10, savedPath: savedIn(SESSION_ID, edit), args: { prompt: "Make the sky orange", input_images: [{ image_id: "sha256:abc" }] } }),
    ], SESSION_ID);

    expect(entries.map((entry) => [entry.type, entry.toolCall?.toolCallId])).toEqual([
      ["tool", "draw"], ["visual", undefined], ["tool", "edit"], ["visual", undefined],
    ]);
    const common = { kind: "image", mimeType: "image/png", size: Buffer.from(PNG_BASE64, "base64").length };
    expect(entries[1].visual).toEqual({
      ...common, artifactId: `generated-${original}`, displayName: original, title: "Generated image", altText: "A bridge at dusk",
      url: `/api/sessions/${SESSION_ID}/images/${original}`, downloadUrl: `/api/sessions/${SESSION_ID}/images/${original}?download`,
    });
    expect(entries[3].visual).toEqual({
      ...common, artifactId: `generated-${edit}`, displayName: edit, title: "Edited image", altText: "Make the sky orange",
      url: `/api/sessions/${SESSION_ID}/images/${edit}`, downloadUrl: `/api/sessions/${SESSION_ID}/images/${edit}?download`,
    });
  });

  it.each([
    { label: "a failed call", options: { success: false } },
    { label: "an image saved for another session", options: { savedPath: savedIn("ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee") } },
    { label: "an image saved outside an images folder", options: { savedPath: `C:\\Users\\someone\\Downloads\\${SESSION_ID}\\image-1.png` } },
  ])("shows no card for $label", ({ options }) => {
    const entries = transformEventsToMessages(imageEvents(options), SESSION_ID);
    expect(entries.filter((entry) => entry.type === "visual")).toEqual([]);
  });
});

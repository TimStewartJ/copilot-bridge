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

function makePublishVisualEvents(opts: {
  toolCallId?: string;
  success?: boolean;
  result?: unknown;
} = {}) {
  const toolCallId = opts.toolCallId ?? "tc-publish-1";
  return [
    {
      type: "user.message",
      timestamp: "2026-04-10T10:00:00.000Z",
      data: { content: "Show me a chart", timestamp: "2026-04-10T10:00:00.000Z" },
    },
    {
      type: "tool.execution_start",
      timestamp: "2026-04-10T10:00:01.000Z",
      data: {
        toolCallId,
        toolName: "publish_visual",
        arguments: { kind: "image", title: "My Chart" },
      },
    },
    {
      type: "tool.execution_complete",
      timestamp: "2026-04-10T10:00:02.000Z",
      data: {
        toolCallId,
        success: opts.success ?? true,
        result: opts.result ?? SAMPLE_VISUAL_RESULT,
      },
    },
  ];
}

describe("event-transform: visual entries", () => {
  it("emits a visual entry after a successful publish_visual tool completion", () => {
    const entries = transformEventsToMessages(makePublishVisualEvents(), SESSION_ID);

    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);

    const v = visualEntries[0];
    expect(v.visual?.artifactId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(v.visual?.kind).toBe("image");
    expect(v.visual?.title).toBe("My Chart");
    expect(v.visual?.mimeType).toBe("image/png");
    expect(v.visual?.url).toMatch(/\/visuals\//);
    expect(v.visual?.downloadUrl).toMatch(/\/download/);
    expect(v.visual?.caption).toBe("Chart caption");
    expect(v.visual?.altText).toBe("chart alt");
  });

  it("emits a visual entry when the persisted tool result is a JSON string", () => {
    const entries = transformEventsToMessages(
      makePublishVisualEvents({ result: JSON.stringify(SAMPLE_VISUAL_RESULT) }),
      SESSION_ID,
    );

    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);
    expect(visualEntries[0].visual?.artifactId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("emits a visual entry when the persisted tool result wraps JSON in content", () => {
    const entries = transformEventsToMessages(
      makePublishVisualEvents({
        result: {
          content: JSON.stringify(SAMPLE_VISUAL_RESULT),
          detailedContent: JSON.stringify(SAMPLE_VISUAL_RESULT),
        },
      }),
      SESSION_ID,
    );

    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);
    expect(visualEntries[0].visual?.artifactId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("also emits the tool entry for the publish_visual call", () => {
    const entries = transformEventsToMessages(makePublishVisualEvents(), SESSION_ID);

    const toolEntries = entries.filter((e) => e.type === "tool");
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].toolCall?.name).toBe("publish_visual");
    expect(toolEntries[0].toolCall?.success).toBe(true);
  });

  it("orders the tool entry before the visual entry", () => {
    const entries = transformEventsToMessages(makePublishVisualEvents(), SESSION_ID);
    const toolIdx = entries.findIndex((e) => e.type === "tool");
    const visualIdx = entries.findIndex((e) => e.type === "visual");
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(visualIdx).toBeGreaterThan(toolIdx);
  });

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

  it("does not emit a visual entry when the result URL only matches in a query string", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440000";
    const entries = transformEventsToMessages(makePublishVisualEvents({
      result: {
        ...SAMPLE_VISUAL_RESULT,
        artifactId,
        url: `/api/admin/dangerous?fake=/sessions/${SESSION_ID}/visuals/${artifactId}`,
      },
    }), SESSION_ID);

    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(0);
  });

  it("does not emit a visual entry when the result URL only matches in a fragment", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440000";
    const entries = transformEventsToMessages(makePublishVisualEvents({
      result: {
        ...SAMPLE_VISUAL_RESULT,
        artifactId,
        url: `/api/admin/dangerous#/sessions/${SESSION_ID}/visuals/${artifactId}`,
      },
    }), SESSION_ID);

    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(0);
  });

  it("does not emit a visual entry when URL parsing resolves to another origin", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440000";
    const entries = transformEventsToMessages(makePublishVisualEvents({
      result: {
        ...SAMPLE_VISUAL_RESULT,
        artifactId,
        url: `/\\evil.example/api/sessions/${SESSION_ID}/visuals/${artifactId}`,
      },
    }), SESSION_ID);

    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(0);
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

  it("handles multiple publish_visual calls in one turn", () => {
    const events = [
      ...makePublishVisualEvents({ toolCallId: "tc-1" }),
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: {
          toolCallId: "tc-2",
          toolName: "publish_visual",
          arguments: { kind: "image", title: "Second" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:04.000Z",
        data: {
          toolCallId: "tc-2",
          success: true,
          result: {
            __kind: "visual.published",
            artifactId: "660e8400-e29b-41d4-a716-446655440000",
            kind: "image",
            title: "Second",
            displayName: "second.png",
            mimeType: "image/jpeg",
            size: 512,
            url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/660e8400-e29b-41d4-a716-446655440000",
            downloadUrl: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/660e8400-e29b-41d4-a716-446655440000/download",
          },
        },
      },
    ];
    const entries = transformEventsToMessages(events, SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(2);
    expect(visualEntries[0].visual?.artifactId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(visualEntries[1].visual?.artifactId).toBe("660e8400-e29b-41d4-a716-446655440000");
  });

  it("preserves other entry types alongside visual entries", () => {
    const events = [
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "Show chart", timestamp: "2026-04-10T10:00:00.000Z" },
      },
      ...makePublishVisualEvents().slice(1),
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:05.000Z",
        data: { content: "Here is your chart." },
      },
    ];
    const entries = transformEventsToMessages(events, SESSION_ID);
    const types = entries.map((e) => e.type);
    expect(types).toContain("message");
    expect(types).toContain("tool");
    expect(types).toContain("visual");
  });
});

describe("event-transform: mermaid visual entries", () => {
  const MERMAID_RESULT = {
    __kind: "visual.published",
    success: true,
    artifactId: "770e8400-e29b-41d4-a716-446655440000",
    kind: "mermaid",
    title: "My Diagram",
    displayName: "My_Diagram.mmd",
    mimeType: "text/vnd.mermaid",
    size: 20,
    url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/770e8400-e29b-41d4-a716-446655440000",
    downloadUrl: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/770e8400-e29b-41d4-a716-446655440000/download",
    source: "graph TD\n  A-->B",
    content: "Mermaid diagram published",
  };

  function makeMermaidEvents() {
    return [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tc-mermaid-1",
          toolName: "publish_visual",
          arguments: { kind: "mermaid", title: "My Diagram" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: {
          toolCallId: "tc-mermaid-1",
          success: true,
          result: MERMAID_RESULT,
        },
      },
    ];
  }

  it("emits a mermaid visual entry with metadata only", () => {
    const entries = transformEventsToMessages(makeMermaidEvents(), SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);

    const v = visualEntries[0];
    expect(v.visual?.kind).toBe("mermaid");
    expect(v.visual?.artifactId).toBe("770e8400-e29b-41d4-a716-446655440000");
    expect(v.visual?.title).toBe("My Diagram");
    expect(v.visual?.mimeType).toBe("text/vnd.mermaid");
    expect(v.visual?.source).toBeUndefined();
  });

  it("does not include source field for image entries", () => {
    const events = [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tc-img", toolName: "publish_visual", arguments: {} },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: {
          toolCallId: "tc-img",
          success: true,
          result: {
            __kind: "visual.published",
            artifactId: "880e8400-e29b-41d4-a716-446655440000",
            kind: "image",
            title: "Photo",
            displayName: "photo.png",
            mimeType: "image/png",
            size: 512,
            url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/880e8400-e29b-41d4-a716-446655440000",
            downloadUrl: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/880e8400-e29b-41d4-a716-446655440000/download",
          },
        },
      },
    ];
    const entries = transformEventsToMessages(events, SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);
    expect(visualEntries[0].visual?.kind).toBe("image");
    expect(visualEntries[0].visual?.source).toBeUndefined();
  });
});

describe("event-transform: vega-lite visual entries", () => {
  const VEGA_LITE_RESULT = {
    __kind: "visual.published",
    success: true,
    artifactId: "990e8400-e29b-41d4-a716-446655440000",
    kind: "vega-lite",
    title: "My Bar Chart",
    displayName: "My_Bar_Chart.vl.json",
    mimeType: "application/vnd.vegalite+json",
    size: 200,
    url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/990e8400-e29b-41d4-a716-446655440000",
    downloadUrl: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/990e8400-e29b-41d4-a716-446655440000/download",
    source: JSON.stringify({ mark: "bar", data: { values: [{ a: "A", b: 28 }] } }, null, 2),
    content: "Vega-Lite chart published",
  };

  function makeVegaLiteEvents() {
    return [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tc-vl-1",
          toolName: "publish_visual",
          arguments: { kind: "vega-lite", title: "My Bar Chart" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: {
          toolCallId: "tc-vl-1",
          success: true,
          result: VEGA_LITE_RESULT,
        },
      },
    ];
  }

  it("emits a vega-lite visual entry with metadata only", () => {
    const entries = transformEventsToMessages(makeVegaLiteEvents(), SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);

    const v = visualEntries[0];
    expect(v.visual?.kind).toBe("vega-lite");
    expect(v.visual?.artifactId).toBe("990e8400-e29b-41d4-a716-446655440000");
    expect(v.visual?.title).toBe("My Bar Chart");
    expect(v.visual?.mimeType).toBe("application/vnd.vegalite+json");
    expect(v.visual?.source).toBeUndefined();
  });

  it("uses default vega-lite mime type when not provided", () => {
    const events = makeVegaLiteEvents();
    const completeEvent = events[1] as any;
    const resultWithoutMime = { ...completeEvent.data.result } as any;
    delete resultWithoutMime.mimeType;
    completeEvent.data = { ...completeEvent.data, result: resultWithoutMime };

    const entries = transformEventsToMessages(events, SESSION_ID);
    const v = entries.filter((e) => e.type === "visual")[0];
    expect(v.visual?.mimeType).toBe("application/vnd.vegalite+json");
  });
});

describe("event-transform: html visual entries", () => {
  const HTML_RESULT = {
    __kind: "visual.published",
    success: true,
    artifactId: "aa0e8400-e29b-41d4-a716-446655440000",
    kind: "html",
    title: "My Page",
    displayName: "My_Page.html",
    mimeType: "text/html",
    size: 40,
    url: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/aa0e8400-e29b-41d4-a716-446655440000",
    downloadUrl: "/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/aa0e8400-e29b-41d4-a716-446655440000/download",
    source: "<html><body>Hello</body></html>",
    content: "HTML sandbox published",
  };

  function makeHtmlEvents() {
    return [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tc-html-1",
          toolName: "publish_visual",
          arguments: { kind: "html", title: "My Page" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: {
          toolCallId: "tc-html-1",
          success: true,
          result: HTML_RESULT,
        },
      },
    ];
  }

  it("emits an html visual entry with metadata only", () => {
    const entries = transformEventsToMessages(makeHtmlEvents(), SESSION_ID);
    const visualEntries = entries.filter((e) => e.type === "visual");
    expect(visualEntries).toHaveLength(1);

    const v = visualEntries[0];
    expect(v.visual?.kind).toBe("html");
    expect(v.visual?.artifactId).toBe("aa0e8400-e29b-41d4-a716-446655440000");
    expect(v.visual?.title).toBe("My Page");
    expect(v.visual?.mimeType).toBe("text/html");
    expect(v.visual?.source).toBeUndefined();
  });

  it("uses text/html mime type when not provided", () => {
    const events = makeHtmlEvents();
    const completeEvent = events[1] as any;
    const resultWithoutMime = { ...completeEvent.data.result } as any;
    delete resultWithoutMime.mimeType;
    completeEvent.data = { ...completeEvent.data, result: resultWithoutMime };

    const entries = transformEventsToMessages(events, SESSION_ID);
    const v = entries.filter((e) => e.type === "visual")[0];
    expect(v.visual?.mimeType).toBe("text/html");
  });
});

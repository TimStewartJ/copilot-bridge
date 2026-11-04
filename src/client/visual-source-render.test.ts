import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualArtifact } from "./api";
import VegaLiteVisual from "./components/VegaLiteVisual";
import { useVisualSource, type VisualSourceState } from "./components/useVisualSource";
import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "./test-react-harness";

const embedCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("vega-embed", () => ({
  default: async (_container: unknown, spec: unknown) => {
    embedCalls.push(spec);
    return { finalize: () => {} };
  },
}));

const BAR_SPEC = {
  mark: "bar",
  data: { values: [{ a: "A", b: 3 }] },
  encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
};
const SPEC = JSON.stringify(BAR_SPEC);

let urlCounter = 0;

function chart(overrides: Partial<VisualArtifact> = {}): VisualArtifact {
  urlCounter += 1;
  const url = `/api/sessions/s1/visuals/chart-${urlCounter}`;
  return {
    artifactId: `chart-${urlCounter}`,
    kind: "vega-lite",
    title: "Chart",
    displayName: "chart.vl.json",
    mimeType: "application/vnd.vegalite+json",
    size: SPEC.length,
    url,
    downloadUrl: `${url}/download`,
    ...overrides,
  };
}

function deferredFetch() {
  const pending: Array<(body: string) => void> = [];
  const fetchMock = vi.fn(() => new Promise((resolve) => {
    pending.push((body) => resolve({ ok: true, status: 200, text: async () => body }));
  }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, respond: (body: string) => pending.shift()?.(body) };
}

const renders: VisualSourceState[] = [];

function SourceProbe({ visual }: { visual: VisualArtifact }) {
  renders.push(useVisualSource(visual));
  return null;
}

let harness: ReactDomHarness | null = null;

beforeEach(async () => {
  harness = await createReactDomHarness();
});

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  renders.length = 0;
  embedCalls.length = 0;
  vi.unstubAllGlobals();
});

describe("VegaLiteVisual", () => {
  const viewport = { width: 800, height: 600 };

  it("shows loading on the first fetch and draws the same source immediately in the expanded view", async () => {
    const { fetchMock, respond } = deferredFetch();
    const visual = chart();
    await harness!.render(createElement(SourceProbe, { visual }));
    expect(renders[0]).toEqual({ source: "", loading: true, error: null });
    await harness!.act(async () => {
      respond(SPEC);
    });
    await waitUntilAct(harness!.act, () => renders.at(-1)?.source === SPEC, { label: "source cached" });

    expect(renders.every((state) => state.loading || state.error !== null || state.source !== "")).toBe(true);

    const wideViewport = { width: 1400, height: 500 };
    await harness!.render(createElement(VegaLiteVisual, { visual, mode: "focus", viewport: wideViewport }));
    await waitUntilAct(harness!.act, () => embedCalls.length === 1, { label: "chart drawn" });
    const drawn = embedCalls[0] as { width: number; height: number };
    expect(drawn).toMatchObject(BAR_SPEC);
    expect(drawn.width).toBeGreaterThan(wideViewport.width / 2);
    expect(drawn.width).toBeLessThanOrEqual(wideViewport.width);
    expect(drawn.height).toBeGreaterThan(wideViewport.height / 2);
    expect(drawn.height).toBeLessThanOrEqual(wideViewport.height);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness!.dom.container.textContent).not.toContain("render error");
  });

  it("still draws when an error clears, because the chart container stays mounted", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const visual = chart({ source: "" });

    await harness!.render(createElement(VegaLiteVisual, { visual, mode: "focus", viewport }));
    expect(harness!.dom.container.textContent).toContain("Vega-Lite spec is empty");

    const authored = {
      hconcat: [BAR_SPEC, { ...BAR_SPEC, mark: "point" }],
      config: { view: { continuousWidth: 240, continuousHeight: 120 } },
    };
    await harness!.render(createElement(VegaLiteVisual, { visual: { ...visual, source: JSON.stringify(authored) }, mode: "focus", viewport }));
    await waitUntilAct(harness!.act, () => embedCalls.length === 1, { label: "chart drawn after the error cleared" });
    expect(embedCalls[0]).toMatchObject(authored);
    expect(harness!.dom.container.textContent).not.toContain("render error");
  });
});

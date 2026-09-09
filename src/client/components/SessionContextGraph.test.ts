import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SessionContextEvent, SessionContextTurn } from "../../shared/session-context.js";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import { installSelectAwareDomShim } from "../test-dom-shim";
import SessionContextGraph from "./SessionContextGraph";
import { getSummaryMetrics } from "./SessionContextHelpers";

function fixture(values: Array<number | null>) {
  const turns: SessionContextTurn[] = values.map((_, index) => ({
    sessionId: "session", bridgeTurnId: `turn-${index}`, provider: "copilot",
    providerSessionId: null, providerTurnId: null, attribution: "turn",
    startedAt: null, endedAt: null, latestEventAt: null, model: null,
  }));
  const events: SessionContextEvent[] = values.map((value, index) => ({
    id: index, sessionId: "session", bridgeTurnId: `turn-${index}`, provider: "copilot",
    providerSessionId: null, providerTurnId: null, providerEventId: null, attribution: "turn",
    type: "context_snapshot", occurredAt: "2026-09-09T00:00:00Z", model: null,
    tokensUsed: value, contextWindow: 1000, tokensRemaining: null, usageRatio: null,
    modelUsage: null, metadata: null,
  }));
  return {
    turns, events,
    eventsByTurnId: new Map(events.map((event) => [event.bridgeTurnId!, [event]])),
    previews: { byTurnId: new Map(), ordered: [] },
  };
}

describe("Context history", () => {
  it("draws a line with gaps for missing usage and zero at the baseline", async () => {
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(SessionContextGraph, fixture([0, 500, null, 200])));
    const path = findAllByTag(harness.dom.container, "PATH")[0];
    const d = getReactProps(path)?.d;
    expect(d).toContain("M48,100 L");
    expect(d.match(/M/g)).toHaveLength(2);
    expect(findAllByTag(harness.dom.container, "CIRCLE")).toHaveLength(3);
    expect(getReactProps(findAllByTag(harness.dom.container, "SVG")[0])?.["aria-label"]).toContain("line graph");
  });

  it("supports keyboard inspection and range selection without losing access to older turns", async () => {
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(SessionContextGraph, fixture(Array.from({ length: 35 }, (_, index) => index * 10))));
    expect(findAllByTag(harness.dom.container, "CIRCLE")).toHaveLength(30);
    const firstPoint = findAllByTag(harness.dom.container, "CIRCLE")[0];
    const preventDefault = vi.fn();
    await harness.act(async () => getReactProps(firstPoint)?.onKeyDown({ key: "Enter", preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    const selects = findAllByTag(harness.dom.container, "SELECT");
    expect(getReactProps(selects[1])?.value).toBe("turn-5");
    await harness.act(async () => getReactProps(selects[0])?.onChange({ target: { value: "all" } }));
    expect(findAllByTag(harness.dom.container, "CIRCLE")).toHaveLength(35);
    await harness.act(async () => getReactProps(selects[1])?.onChange({ target: { value: "turn-0" } }));
    expect(getReactProps(findAllByTag(harness.dom.container, "CIRCLE")[0])?.["aria-pressed"]).toBe(true);
  });

  it("does not invent a series when usage is unknown, and retains event details", async () => {
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    const props = fixture([null]);
    props.events[0].type = "compaction";
    await harness.render(createElement(SessionContextGraph, props));
    expect(findAllByTag(harness.dom.container, "SVG")).toHaveLength(0);
    expect(harness.dom.container.textContent).toContain("No context history yet");
    expect(harness.dom.container.textContent).toContain("Compaction");
    expect(harness.dom.container.textContent).toContain("unavailable");
  });

  it("uses a percent axis if only ratios are reported", async () => {
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    const props = fixture([null]);
    props.events[0].usageRatio = 0.5;
    await harness.render(createElement(SessionContextGraph, props));
    expect(getReactProps(findAllByTag(harness.dom.container, "SVG")[0])?.["aria-label"]).toContain("percent");
    expect(getReactProps(findAllByTag(harness.dom.container, "CIRCLE")[0])?.cy).toBe(56);
  });

  it("keeps derived sub-one-percent context usage small", () => {
    expect(getSummaryMetrics({ tokensUsed: 5, contextWindow: 1000, tokensRemaining: 995, usageRatio: null }).percent).toBe(0.5);
  });
});

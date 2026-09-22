import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import { getSummaryMetrics } from "./SessionContextHelpers";
import SessionContextPanel from "./SessionContextPanel";

describe("SessionContextPanel", () => {
  it("keeps loading, unknown and failed context distinct without showing an empty graph", async () => {
    const harness = await createReactDomHarness();
    await harness.render(createElement(SessionContextPanel, { loading: true }));
    expect(harness.dom.container.textContent).toContain("Loading usage...");
    await harness.render(createElement(SessionContextPanel));
    expect(harness.dom.container.textContent).toContain("Context usage unavailable");
    expect(harness.dom.container.textContent).not.toContain("No context history");
    expect(findAllByTag(harness.dom.container, "DIV").some(node => getReactProps(node)?.role === "progressbar")).toBe(false);
    await harness.render(createElement(SessionContextPanel, { error: "Context service offline" }));
    expect(harness.dom.container.textContent).toContain("Context unavailable");
    expect(harness.dom.container.textContent).toContain("Context service offline");
    expect(findAllByTag(harness.dom.container, "DIV").some(node => getReactProps(node)?.role === "alert")).toBe(true);
  });

  it("keeps derived sub-one-percent context usage small", () => {
    expect(getSummaryMetrics({ tokensUsed: 5, contextWindow: 1000, tokensRemaining: 995, usageRatio: null }).percent).toBe(0.5);
  });
});

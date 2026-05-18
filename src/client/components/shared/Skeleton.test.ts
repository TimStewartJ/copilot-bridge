import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, waitForDelayAct } from "../../test-react-harness";
import {
  LoadingSkeletonRegion,
  Skeleton,
  SkeletonCard,
  SkeletonRow,
  SkeletonText,
} from "./Skeleton";

describe("shared skeleton primitives", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders decorative skeletons with reduced-motion-safe classes", () => {
    const html = renderToStaticMarkup(
      createElement(
        LoadingSkeletonRegion,
        { isLoading: true, label: "Loading dashboard" },
        createElement(
          SkeletonCard,
          null,
          createElement(Skeleton, { height: 16, width: "40%" }),
          createElement(SkeletonText, { lines: 2, widths: ["100%", "64%"] }),
          createElement(SkeletonRow, { leading: "circle" }),
        ),
      ),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading dashboard");
    expect(html).toContain("sr-only");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pulse");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("delays rendering to avoid loading flicker", async () => {
    vi.useFakeTimers();
    const harness = await createReactDomHarness();

    try {
      await harness.render(
        createElement(
          LoadingSkeletonRegion,
          {
            isLoading: true,
            label: "Loading settings",
            delayMs: 100,
            children: createElement(SkeletonText, null),
          },
        ),
      );
      expect(harness.dom.container.textContent).toBe("");

      await waitForDelayAct(harness.act, 100);
      expect(harness.dom.container.textContent).toContain("Loading settings");

      await harness.render(
        createElement(
          LoadingSkeletonRegion,
          {
            isLoading: false,
            label: "Loading settings",
            delayMs: 100,
            children: createElement(SkeletonText, null),
          },
        ),
      );
      expect(harness.dom.container.textContent).toBe("");
    } finally {
      await harness.cleanup();
    }
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDomShim } from "../../test-dom-shim";
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
    const dom = installDomShim();

    try {
      const [{ createRoot }, { flushSync }, { act }] = await Promise.all([
        import("react-dom/client"),
        import("react-dom"),
        import("react"),
      ]);
      const root = createRoot(dom.container as unknown as Element);

      flushSync(() => {
        root.render(
          createElement(
            LoadingSkeletonRegion,
            { isLoading: true, label: "Loading settings", delayMs: 100 },
            createElement(SkeletonText, null),
          ),
        );
      });
      expect(dom.container.textContent).toBe("");

      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(dom.container.textContent).toContain("Loading settings");

      flushSync(() => {
        root.render(
          createElement(
            LoadingSkeletonRegion,
            { isLoading: false, label: "Loading settings", delayMs: 100 },
            createElement(SkeletonText, null),
          ),
        );
      });
      expect(dom.container.textContent).toBe("");

      flushSync(() => root.unmount());
    } finally {
      dom.cleanup();
    }
  });
});

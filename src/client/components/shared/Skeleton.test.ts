import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceTimersByTimeAct, createReactDomHarness, findAllByTag } from "../../test-react-harness";
import { LoadingSkeletonRegion, SkeletonText } from "./Skeleton";

describe("shared skeleton primitives", () => {
  afterEach(() => {
    vi.useRealTimers();
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

      await advanceTimersByTimeAct(harness.act, 100);
      const status = findAllByTag(harness.dom.container, "SPAN").find((node) => node.getAttribute("role") === "status");
      expect(status?.textContent).toBe("Loading settings");
      const surfaces = findAllByTag(harness.dom.container, "DIV");
      const busy = surfaces.find((node) => node.getAttribute("aria-busy") === "true");
      expect(busy?.getAttribute("aria-describedby")).toBe(status.getAttribute("id"));
      const placeholders = surfaces.filter((node) => node.getAttribute("aria-hidden") === "true");
      expect(placeholders.length).toBeGreaterThan(0);
      expect(placeholders.every((node) => node.getAttribute("class")?.includes("motion-reduce:animate-none"))).toBe(true);
      expect(findAllByTag(busy, "BUTTON")).toHaveLength(0);
      expect(findAllByTag(busy, "A")).toHaveLength(0);

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

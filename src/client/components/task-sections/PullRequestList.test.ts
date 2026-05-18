import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EnrichedPR, PRRef } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import type { PullRequestListProps } from "./PullRequestList";

type PullRequestHarness = Awaited<ReturnType<typeof createReactDomHarness>>;

// -- Fixtures ---------------------------------------------------------

function makePR(prId: number, url: string): EnrichedPR {
  return { repoId: "repo-1", repoName: "org/repo", prId, provider: "github", title: `PR #${prId}`, status: "active", createdBy: null, reviewerCount: 0, url };
}

const prA = makePR(1, "https://github.com/org/repo/pull/1");
const prB = makePR(2, "https://github.com/org/repo/pull/2");
const prReal = makePR(3, "https://github.com/org/repo/pull/3");
const rawPROnly: PRRef[] = [{ repoId: "repo-1", prId: 99, provider: "github" }];

async function withPullRequestList(
  props: PullRequestListProps,
  run: (harness: PullRequestHarness) => Promise<void> | void,
) {
  const harness = await createReactDomHarness();
  try {
    const { default: PullRequestList } = await import("./PullRequestList");
    await harness.render(createElement(PullRequestList, props));
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

async function clickFirstSummaryButton(harness: PullRequestHarness) {
  const [button] = findAllByTag(harness.dom.container, "BUTTON");
  if (!button) throw new Error("Summary button was not rendered");
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button });
  });
}

// -- Tests ------------------------------------------------------------

describe("PullRequestList - summary variant", () => {
  it("multiple PRs are collapsed by default", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }, (harness) => {
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("clicking summary expands and reveals compact linked rows", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);
    });
  });

  it("clicking summary again collapses", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);

      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("changing resetKey collapses expanded content", async () => {
    await withPullRequestList({
      enrichedPRs: [prA, prB],
      rawPRs: [],
      variant: "summary",
      resetKey: "task-1",
    }, async (harness) => {
      const { default: PullRequestList } = await import("./PullRequestList");
      const prs = [prA, prB];

      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);

      await harness.render(createElement(PullRequestList, {
        enrichedPRs: prs,
        rawPRs: [],
        variant: "summary",
        resetKey: "task-2",
      }));

      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("expanded rows contain external anchor links", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      const anchors = findAllByTag(harness.dom.container, "A");
      expect(anchors).toHaveLength(2);
      for (const anchor of anchors) {
        expect(anchor.getAttribute("target")).toBe("_blank");
        expect(anchor.getAttribute("rel")).toBe("noopener");
        expect(anchor.getAttribute("href")).toMatch(/^https?:\/\//);
      }
    });
  });

  it("single PR with a real URL calls window.open", async () => {
    await withPullRequestList({ enrichedPRs: [prReal], rawPRs: [], variant: "summary" }, async (harness) => {
      const mockOpen = vi.fn();
      (globalThis.window as unknown as { open?: typeof mockOpen }).open = mockOpen;
      try {
        await clickFirstSummaryButton(harness);

        expect(mockOpen).toHaveBeenCalledOnce();
        expect(mockOpen).toHaveBeenCalledWith(prReal.url, "_blank", "noopener");
      } finally {
        delete (globalThis.window as unknown as { open?: typeof mockOpen }).open;
      }
    });
  });

  it("single PR with url '#' (raw fallback) does not navigate", async () => {
    await withPullRequestList({ enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }, async (harness) => {
      const mockOpen = vi.fn();
      (globalThis.window as unknown as { open?: typeof mockOpen }).open = mockOpen;
      try {
        await clickFirstSummaryButton(harness);

        expect(mockOpen).not.toHaveBeenCalled();
      } finally {
        delete (globalThis.window as unknown as { open?: typeof mockOpen }).open;
      }
    });
  });

  it("single PR with missing URL expands inline on click", async () => {
    await withPullRequestList({ enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }, async (harness) => {
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);

      await clickFirstSummaryButton(harness);

      const divs = findAllByTag(harness.dom.container, "DIV");
      expect(divs.length).toBeGreaterThan(0);
    });
  });

  it("expanded rows with missing URL do not render href='#' anchors", async () => {
    await withPullRequestList({ enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      const anchors = findAllByTag(harness.dom.container, "A");
      for (const anchor of anchors) {
        const href = anchor.getAttribute("href") ?? "";
        expect(href).not.toBe("#");
        expect(href).toMatch(/^https?:\/\//);
      }
    });
  });
});

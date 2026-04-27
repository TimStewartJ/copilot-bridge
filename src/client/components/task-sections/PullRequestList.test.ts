import { createElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { installDomShim } from "../../test-dom-shim";
import type { EnrichedPR, PRRef } from "../../api";

// ── DOM helpers ────────────────────────────────────────────────────

function findAllByTag(root: any, tag: string): any[] {
  const results: any[] = [];
  if ((root.tagName ?? "").toUpperCase() === tag.toUpperCase()) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

function getReactProps(el: any): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return key ? el[key] : null;
}

async function waitTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── Fixtures ───────────────────────────────────────────────────────

function makePR(prId: number, url: string): EnrichedPR {
  return { repoId: "repo-1", repoName: "org/repo", prId, provider: "github", title: `PR #${prId}`, status: "active", createdBy: null, reviewerCount: 0, url };
}

const prA = makePR(1, "https://github.com/org/repo/pull/1");
const prB = makePR(2, "https://github.com/org/repo/pull/2");
const prReal = makePR(3, "https://github.com/org/repo/pull/3");
const rawPROnly: PRRef[] = [{ repoId: "repo-1", prId: 99, provider: "github" }];

// ── Tests ──────────────────────────────────────────────────────────

describe("PullRequestList – summary variant", () => {
  it("multiple PRs are collapsed by default", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }));
      });
      expect(findAllByTag(dom.container, "A")).toHaveLength(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("clicking summary expands and reveals compact linked rows", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      expect(findAllByTag(dom.container, "A")).toHaveLength(2);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("clicking summary again collapses", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }));
      });

      // expand
      let [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });
      expect(findAllByTag(dom.container, "A")).toHaveLength(2);

      // collapse
      [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });
      expect(findAllByTag(dom.container, "A")).toHaveLength(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("changing resetKey collapses expanded content", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }, { act }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
      import("react"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      const prs = [prA, prB];

      await act(async () => {
        root.render(createElement(PullRequestList, { enrichedPRs: prs, rawPRs: [], variant: "summary", resetKey: "task-1" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      await act(async () => { getReactProps(button)?.onClick?.(); });

      expect(findAllByTag(dom.container, "A")).toHaveLength(2);

      // change resetKey → useEffect fires → collapsed
      await act(async () => {
        root.render(createElement(PullRequestList, { enrichedPRs: prs, rawPRs: [], variant: "summary", resetKey: "task-2" }));
      });

      expect(findAllByTag(dom.container, "A")).toHaveLength(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("expanded rows contain external anchor links", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      const anchors = findAllByTag(dom.container, "A");
      expect(anchors).toHaveLength(2);
      for (const a of anchors) {
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toBe("noopener");
        expect(a.getAttribute("href")).toMatch(/^https?:\/\//);
      }
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("single PR with a real URL calls window.open", async () => {
    const dom = installDomShim();
    const mockOpen = vi.fn();
    (globalThis as any).window.open = mockOpen;

    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [prReal], rawPRs: [], variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      expect(mockOpen).toHaveBeenCalledOnce();
      expect(mockOpen).toHaveBeenCalledWith(prReal.url, "_blank", "noopener");
    } finally {
      delete (globalThis as any).window.open;
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("single PR with url '#' (raw fallback) does not navigate", async () => {
    const dom = installDomShim();
    const mockOpen = vi.fn();
    (globalThis as any).window.open = mockOpen;

    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      expect(mockOpen).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as any).window.open;
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("single PR with missing URL expands inline on click", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }));
      });

      // collapsed by default – no child rows
      expect(findAllByTag(dom.container, "A")).toHaveLength(0);

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      // after clicking, the disclosure panel should be visible (contains at least one child DIV row)
      const divs = findAllByTag(dom.container, "DIV");
      expect(divs.length).toBeGreaterThan(0);
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });

  it("expanded rows with missing URL do not render href='#' anchors", async () => {
    const dom = installDomShim();
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import("react-dom/client"),
      import("react-dom"),
    ]);
    const { default: PullRequestList } = await import("./PullRequestList");
    const root = createRoot(dom.container as any);
    try {
      flushSync(() => {
        root.render(createElement(PullRequestList, { enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }));
      });

      const [button] = findAllByTag(dom.container, "BUTTON");
      flushSync(() => { getReactProps(button)?.onClick?.(); });

      const anchors = findAllByTag(dom.container, "A");
      for (const a of anchors) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toBe("#");
        expect(href).toMatch(/^https?:\/\//);
      }
    } finally {
      flushSync(() => root.unmount());
      await waitTick();
      dom.cleanup();
    }
  });
});

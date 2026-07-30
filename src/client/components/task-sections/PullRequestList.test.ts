import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichedPR, PRRef } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  flushAct,
  getReactProps,
} from "../../test-react-harness";
import type { PullRequestListProps } from "./PullRequestList";
import type { ToastInput } from "../../useToast";

const apiMocks = vi.hoisted(() => ({ unlinkResource: vi.fn(), linkResource: vi.fn() }));
const toastMocks = vi.hoisted(() => ({ showToast: vi.fn(() => "toast-1"), dismissToast: vi.fn() }));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, unlinkResource: apiMocks.unlinkResource, linkResource: apiMocks.linkResource };
});

vi.mock("../../useToast", async () => {
  const actual = await vi.importActual<typeof import("../../useToast")>("../../useToast");
  return { ...actual, useToast: () => ({ ...toastMocks, updateToast: vi.fn() }) };
});

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

function findUnlinkButtons(harness: PullRequestHarness) {
  return findAllByTag(harness.dom.container, "BUTTON")
    .filter((button) => (button.getAttribute("aria-label") ?? "").startsWith("Unlink pull request"));
}

/** Latest toast payload passed to showToast. */
function lastToast(): ToastInput | undefined {
  const calls = toastMocks.showToast.mock.calls as unknown as [ToastInput][];
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

async function clickUnlink(harness: PullRequestHarness, index = 0) {
  const button = findUnlinkButtons(harness)[index];
  if (!button) throw new Error("Unlink button was not rendered");
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button });
  });
  await flushAct(harness.act);
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

describe("PullRequestList - unlink affordance", () => {
  beforeEach(() => {
    apiMocks.unlinkResource.mockReset();
    apiMocks.unlinkResource.mockResolvedValue({});
    apiMocks.linkResource.mockReset();
    apiMocks.linkResource.mockResolvedValue({});
    toastMocks.showToast.mockClear();
    toastMocks.dismissToast.mockClear();
  });

  it("renders no unlink button when taskId is omitted", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "compact" }, (harness) => {
      expect(findUnlinkButtons(harness)).toHaveLength(0);
    });
  });

  it("renders one unlink button per row when taskId is provided", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "compact", taskId: "task-1" }, (harness) => {
      expect(findUnlinkButtons(harness)).toHaveLength(2);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(2);
    });
  });

  it("unlinks immediately without a confirmation prompt", async () => {
    const confirmMock = vi.fn(() => false);
    (globalThis.window as unknown as { confirm?: typeof confirmMock }).confirm = confirmMock;
    try {
      await withPullRequestList(
        { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1" },
        async (harness) => {
          await clickUnlink(harness);

          expect(confirmMock).not.toHaveBeenCalled();
          expect(apiMocks.unlinkResource).toHaveBeenCalledOnce();
        },
      );
    } finally {
      delete (globalThis.window as unknown as { confirm?: typeof confirmMock }).confirm;
    }
  });

  it("unlinks with the row provider/repo/PR id and notifies the parent", async () => {
    const onTasksChanged = vi.fn();
    await withPullRequestList(
      { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "pr",
          repoId: "repo-1",
          prId: 1,
          provider: "github",
        });
        expect(onTasksChanged).toHaveBeenCalledOnce();
      },
    );
  });

  it("shows a success toast offering undo", async () => {
    await withPullRequestList(
      { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1" },
      async (harness) => {
        await clickUnlink(harness);

        const toast = lastToast();
        expect(toast?.tone).toBe("success");
        expect(toast?.title).toBe("Unlinked pull request #1");
        expect(toast?.description).toBe("org/repo");
        expect(toast?.action?.label).toBe("Undo");
      },
    );
  });

  it("undo re-links the PR with its repo name and dismisses its toast", async () => {
    const onTasksChanged = vi.fn();
    await withPullRequestList(
      { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);
        onTasksChanged.mockClear();

        await harness.act(async () => {
          await lastToast()?.action?.onAction();
        });
        await flushAct(harness.act);

        expect(apiMocks.linkResource).toHaveBeenCalledWith("task-1", {
          type: "pr",
          repoId: "repo-1",
          repoName: "org/repo",
          prId: 1,
          provider: "github",
        });
        expect(onTasksChanged).toHaveBeenCalledOnce();
        expect(toastMocks.dismissToast).toHaveBeenCalledWith("toast-1");
      },
    );
  });

  it("reports a failed undo through an error toast", async () => {
    apiMocks.linkResource.mockRejectedValueOnce(new Error("Task not found"));
    await withPullRequestList(
      { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1" },
      async (harness) => {
        await clickUnlink(harness);

        const undo = lastToast()?.action?.onAction;
        await harness.act(async () => { await undo?.(); });
        await flushAct(harness.act);

        const toast = lastToast();
        expect(toast?.tone).toBe("error");
        expect(toast?.title).toBe("Could not restore pull request #1");
        expect(toastMocks.dismissToast).not.toHaveBeenCalled();
      },
    );
  });

  it("unlinks raw fallback rows that have no enriched URL", async () => {
    await withPullRequestList(
      { enrichedPRs: [], rawPRs: rawPROnly, variant: "compact", taskId: "task-1" },
      async (harness) => {
        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "pr",
          repoId: "repo-1",
          prId: 99,
          provider: "github",
        });
      },
    );
  });

  it("surfaces an error toast and skips the parent refresh when unlink fails", async () => {
    const onTasksChanged = vi.fn();
    apiMocks.unlinkResource.mockRejectedValueOnce(new Error("Task not found"));
    await withPullRequestList(
      { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        await clickUnlink(harness);

        const toast = lastToast();
        expect(toast?.tone).toBe("error");
        expect(toast?.description).toContain("Task not found");
        expect(toast?.action).toBeUndefined();
        expect(onTasksChanged).not.toHaveBeenCalled();
      },
    );
  });

  it("forwards unlink props through the summary disclosure", async () => {
    await withPullRequestList(
      { enrichedPRs: [prA, prB], rawPRs: [], variant: "summary", taskId: "task-1" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(0);

        await clickFirstSummaryButton(harness);

        expect(findUnlinkButtons(harness)).toHaveLength(2);
      },
    );
  });

  it("exposes an unlink button on a single-PR summary row that cannot expand", async () => {
    await withPullRequestList(
      { enrichedPRs: [prReal], rawPRs: [], variant: "summary", taskId: "task-1" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(1);

        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "pr",
          repoId: "repo-1",
          prId: 3,
          provider: "github",
        });
      },
    );
  });

  it("does not duplicate the unlink button when a single PR expands inline", async () => {
    await withPullRequestList(
      { enrichedPRs: [], rawPRs: rawPROnly, variant: "summary", taskId: "task-1" },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(0);

        await clickFirstSummaryButton(harness);

        expect(findUnlinkButtons(harness)).toHaveLength(1);
      },
    );
  });
});

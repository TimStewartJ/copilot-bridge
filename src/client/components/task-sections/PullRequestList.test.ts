import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichedPR, PRRef } from "../../api";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  flushAct,
  getReactProps,
} from "../../test-react-harness";
import type { PullRequestListProps } from "./PullRequestList";
import type { ToastInput } from "../../useToast";

const apiMocks = vi.hoisted(() => ({ unlinkResource: vi.fn(), linkResource: vi.fn() }));
const toastMocks = vi.hoisted(() => ({ showToast: vi.fn(() => "toast-1"), dismissToast: vi.fn() }));
const clipboardMocks = vi.hoisted(() => ({ writeClipboardText: vi.fn() }));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, unlinkResource: apiMocks.unlinkResource, linkResource: apiMocks.linkResource };
});

vi.mock("../../useToast", async () => {
  const actual = await vi.importActual<typeof import("../../useToast")>("../../useToast");
  return { ...actual, useToast: () => ({ ...toastMocks, updateToast: vi.fn() }) };
});

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: clipboardMocks.writeClipboardText,
}));

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
    .filter((button) => (button.getAttribute("class") ?? "").includes("linked-resource-unlink-button"));
}

function findCopyButtons(harness: PullRequestHarness) {
  return findAllByTag(harness.dom.container, "BUTTON")
    .filter((button) => (button.getAttribute("class") ?? "").includes("linked-resource-copy-button"));
}

/** Latest toast payload passed to showToast. */
function lastToast(): ToastInput | undefined {
  const calls = toastMocks.showToast.mock.calls as unknown as [ToastInput][];
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

async function clickUnlinkOnce(harness: PullRequestHarness, index = 0) {
  const button = findUnlinkButtons(harness)[index];
  if (!button) throw new Error("Unlink button was not rendered");
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button, preventDefault, stopPropagation });
  });
  await flushAct(harness.act);
  return { button, preventDefault, stopPropagation };
}

async function clickUnlink(harness: PullRequestHarness, index = 0) {
  await clickUnlinkOnce(harness, index);
  await clickUnlinkOnce(harness, index);
}

async function clickCopy(harness: PullRequestHarness, index = 0) {
  const button = findCopyButtons(harness)[index];
  if (!button) throw new Error("Copy button was not rendered");
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  await harness.act(async () => {
    getReactProps(button)?.onClick?.({ currentTarget: button, preventDefault, stopPropagation });
  });
  await flushAct(harness.act);
  return { button, preventDefault, stopPropagation };
}

// -- Tests ------------------------------------------------------------

describe("PullRequestList - summary variant", () => {
  beforeEach(() => {
    clipboardMocks.writeClipboardText.mockReset();
    clipboardMocks.writeClipboardText.mockResolvedValue(undefined);
  });

  it("expands linked rows, copies the selected URL and collapses the summary", async () => {
    await withPullRequestList({ enrichedPRs: [prA, prB], rawPRs: [], variant: "summary" }, async (harness) => {
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);

      await clickFirstSummaryButton(harness);
      const anchors = findAllByTag(harness.dom.container, "A");
      expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([prA.url, prB.url]);
      expect(anchors[0].getAttribute("target")).toBe("_blank");
      expect(anchors[0].getAttribute("rel")).toBe("noopener");

      expect(findCopyButtons(harness)).toHaveLength(2);
      expect(findUnlinkButtons(harness)).toHaveLength(0);
      const { button, preventDefault, stopPropagation } = await clickCopy(harness, 1);

      expect(clipboardMocks.writeClipboardText).toHaveBeenCalledWith(prB.url);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
      expect(button.getAttribute("aria-label")).toBe("Copied pull request #2 URL");

      await clickFirstSummaryButton(harness);
      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    });
  });

  it("expanded rows with missing URL do not render href='#' anchors", async () => {
    await withPullRequestList({ enrichedPRs: [], rawPRs: rawPROnly, variant: "summary" }, async (harness) => {
      await clickFirstSummaryButton(harness);

      expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
      expect(findCopyButtons(harness)).toHaveLength(0);
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

  it("disarms the in-place confirmation after a short timeout", async () => {
    vi.useFakeTimers();
    try {
      await withPullRequestList(
        { enrichedPRs: [prA], rawPRs: [], variant: "compact", taskId: "task-1" },
        async (harness) => {
          await clickUnlinkOnce(harness);
          expect(findUnlinkButtons(harness)[0]?.getAttribute("data-unlink-state")).toBe("confirming");

          await advanceTimersByTimeAct(harness.act, 3000);

          expect(findUnlinkButtons(harness)[0]?.getAttribute("data-unlink-state")).toBe("idle");
          await clickUnlinkOnce(harness);
          expect(apiMocks.unlinkResource).not.toHaveBeenCalled();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlinks with the row provider/repo/PR id and notifies the parent before undo restores that row", async () => {
    const onTasksChanged = vi.fn();
    await withPullRequestList(
      { enrichedPRs: [prA, prB], rawPRs: [], variant: "compact", taskId: "task-1", onTasksChanged },
      async (harness) => {
        expect(findUnlinkButtons(harness)).toHaveLength(2);
        const previousConfirm = window.confirm;
        const confirmMock = vi.fn(() => false);
        window.confirm = confirmMock;
        try {
          const { button, preventDefault, stopPropagation } = await clickUnlinkOnce(harness, 1);

          expect(confirmMock).not.toHaveBeenCalled();
          expect(apiMocks.unlinkResource).not.toHaveBeenCalled();
          expect(button.getAttribute("aria-label")).toBe("Confirm unlink pull request #2 from task");
          expect(button.getAttribute("data-unlink-state")).toBe("confirming");
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(stopPropagation).toHaveBeenCalledOnce();

          await clickUnlinkOnce(harness, 1);
        } finally {
          window.confirm = previousConfirm;
        }
        expect(apiMocks.unlinkResource).toHaveBeenCalledOnce();

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-1", {
          type: "pr",
          repoId: "repo-1",
          prId: 2,
          provider: "github",
        });
        expect(onTasksChanged).toHaveBeenCalledOnce();

        const toast = lastToast();
        expect(toast?.tone).toBe("success");
        expect(toast?.action?.label).toBe("Undo");
        onTasksChanged.mockClear();

        await harness.act(async () => {
          await toast?.action?.onAction();
        });
        await flushAct(harness.act);

        expect(apiMocks.linkResource).toHaveBeenCalledWith("task-1", {
          type: "pr",
          repoId: "repo-1",
          repoName: "org/repo",
          prId: 2,
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

  it("opens a single linked pull request inline with its unlink action", async () => {
    await withPullRequestList(
      { enrichedPRs: [prReal], rawPRs: [], variant: "summary", taskId: "task-single-summary" },
      async (harness) => {
        const open = vi.fn();
        const previousOpen = window.open;
        window.open = open;
        try {
          expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
          expect(findUnlinkButtons(harness)).toHaveLength(0);
          await clickFirstSummaryButton(harness);
          expect(open).not.toHaveBeenCalled();
          expect(findAllByTag(harness.dom.container, "A")[0]?.getAttribute("href")).toBe(prReal.url);
        } finally {
          window.open = previousOpen;
        }
        expect(findUnlinkButtons(harness)).toHaveLength(1);

        await clickUnlink(harness);

        expect(apiMocks.unlinkResource).toHaveBeenCalledWith("task-single-summary", {
          type: "pr",
          repoId: "repo-1",
          prId: 3,
          provider: "github",
        });
      },
    );
  });
});

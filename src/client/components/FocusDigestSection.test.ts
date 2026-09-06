import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusDigest, FocusObjectPage, FocusEvent } from "../api";
import { focusDigest, focusEvent, focusTask, FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";

const api = vi.hoisted(() => ({ fetchFocusEventDigestPage: vi.fn(), markFocusDigestViewed: vi.fn(), fetchFocusLaunchReceipts: vi.fn() }));
vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), ...api }));
import FocusDigestSection from "./FocusDigestSection";

describe("Focus digests and consumption receipts", () => {
  let harness: FocusTestHarness;
  const page = (objects: FocusEvent[] = [focusEvent()], nextOffset: number | null = null): FocusObjectPage<FocusEvent> => ({ objects, total: nextOffset ? 21 : objects.length, nextOffset });
  beforeEach(async () => {
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    api.fetchFocusEventDigestPage.mockReset().mockResolvedValue(page());
    api.fetchFocusLaunchReceipts.mockReset().mockResolvedValue([]);
    api.markFocusDigestViewed.mockReset().mockImplementation(async (digestId: string, lastViewedAt: string) => ({ digestId, lastViewedAt }));
  });
  afterEach(async () => { await harness.cleanup(); });
  const render = (digest: FocusDigest = focusDigest()) => harness.render(createElement(FocusDigestSection, {
    digest, tasks: [focusTask()], taskGroups: [], onSelectTask: vi.fn(), onSelectSession: vi.fn(),
    onStartPromptSession: vi.fn(async () => "session-1"), onChanged: vi.fn(async () => undefined),
  }));
  const toggle = () => harness.act(async () => {
    getReactProps(findAllByTag(harness.dom.container, "BUTTON")[0])?.onClick?.();
    await waitTick();
  });
  const waitForItems = () => waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Create Action")));

  it("fetches and marks a digest viewed only when it is actually opened", async () => {
    await render();
    expect(harness.dom.container.textContent).toContain("3 new");
    expect(harness.dom.container.textContent).toContain("Last meaningful change");
    expect(api.fetchFocusEventDigestPage).not.toHaveBeenCalled();
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
    await toggle();
    await waitForItems();
    expect(api.fetchFocusEventDigestPage).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", sourceFamily: "release-watch" }), 0);
    expect(api.markFocusDigestViewed).toHaveBeenCalledExactlyOnceWith(focusDigest().id, FOCUS_TEST_NOW);
    expect(harness.dom.container.textContent).toContain("7 days, plus pinned Events");
    expect(harness.dom.container.textContent).toContain("not a coverage assurance");
    await toggle();
    expect(api.markFocusDigestViewed).toHaveBeenCalledOnce();
  });

  it("keeps quiet sources explicit and gives their Events the same handoff dialog", async () => {
    await render(focusDigest({ quiet: true }));
    await toggle();
    await waitForItems();
    expect(harness.dom.container.textContent).toContain("Quiet does not mean resolved or healthy");
    await clickFocusButton(harness, "Create Action");
    expect(findAllByTag(harness.dom.container, "DIV").some((node) => getReactProps(node)?.role === "dialog")).toBe(true);
    expect(harness.dom.container.textContent).toContain("Executable Action text");
    expect(harness.dom.container.textContent).toContain("Destination (required)");
  });

  it("does not consume failed or empty digest reads and exposes local recovery", async () => {
    api.fetchFocusEventDigestPage.mockRejectedValueOnce(new Error("source unavailable"));
    await render();
    await toggle();
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("source unavailable")));
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Retry source items");
    await waitForItems();
    expect(api.markFocusDigestViewed).toHaveBeenCalledOnce();
  });

  it("preserves loaded items when a later page fails and retries without consuming again", async () => {
    api.fetchFocusEventDigestPage.mockResolvedValueOnce(page([focusEvent()], 20)).mockRejectedValueOnce(new Error("later page failed")).mockResolvedValueOnce(page([focusEvent({ id: "event-2", title: "Older observation" })]));
    await render();
    await toggle();
    await waitForItems();
    await clickFocusButton(harness, "Load more items");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("later page failed")));
    expect(harness.dom.container.textContent).toContain("Release observation");
    await clickFocusButton(harness, "Load more items");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Older observation")));
    expect(api.markFocusDigestViewed).toHaveBeenCalledOnce();
  });

  it("uses the rendered server watermark rather than the browser clock and freezes retries", async () => {
    vi.setSystemTime(FOCUS_TEST_NOW_MS + 12 * 60 * 60_000);
    api.markFocusDigestViewed.mockRejectedValueOnce(new Error("receipt unavailable"));
    const digest = focusDigest();
    await render(digest);
    await toggle();
    await waitForItems();
    await advanceTimersByTimeAct(harness.act, 1);
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("receipt unavailable")));
    await render({ ...digest, latestUpdatedAt: "2026-09-05T19:00:00.000Z", newCount: 4 });
    await clickFocusButton(harness, "Retry view receipt");
    await waitUntilAct(harness.act, () => api.markFocusDigestViewed.mock.calls.length === 2);
    expect(api.markFocusDigestViewed.mock.calls.map((call) => call[1])).toEqual([FOCUS_TEST_NOW, FOCUS_TEST_NOW]);
  });

  it("does not mark beyond the observations actually rendered", async () => {
    await render(focusDigest({ latestUpdatedAt: "2026-09-05T19:00:00.000Z" }));
    await toggle();
    await waitForItems();
    expect(api.markFocusDigestViewed).toHaveBeenCalledWith(focusDigest().id, FOCUS_TEST_NOW);
  });
});

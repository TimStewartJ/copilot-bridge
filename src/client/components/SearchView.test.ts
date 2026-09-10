import { createElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeSearchResponse } from "../../shared/search.js";
import {
  createReactDomHarness,
  advanceTimersByTimeAct,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import SearchView from "./SearchView";
import { getSearchHighlightTerms } from "../lib/search-text";
import { installFocusDialogDom } from "../test-focus-harness";

const searchBridgeMock = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    searchBridge: (...args: unknown[]) => searchBridgeMock(...args),
  };
});

function response(overrides: Partial<BridgeSearchResponse> = {}): BridgeSearchResponse {
  return {
    chats: { items: [], total: 0 },
    tasks: { items: [], total: 0 },
    docs: { items: [], total: 0 },
    coverage: {
      state: "ready",
      indexedSessions: 3,
      totalSessions: 3,
      errors: [],
    },
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

function ReturnToSearch() {
  const navigate = useNavigate();
  return createElement("button", { onClick: () => navigate(-1) }, "Return to search");
}

function findButton(root: any, text: string) {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("SearchView", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    searchBridgeMock.mockReset();
    await harness?.cleanup();
    harness = null;
  });

  async function render(entry: string) {
    harness = await createReactDomHarness({ installDom: installFocusDialogDom });
    await harness.render(createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(Routes, null,
        createElement(Route, {
          path: "*",
          element: createElement("div", null, createElement(SearchView), createElement(LocationProbe)),
        }),
      ),
    ));
    return harness;
  }

  it("renders scoped grouped results, safe highlights, labels, and exact-message navigation", async () => {
    searchBridgeMock.mockResolvedValue(response({
      chats: {
        total: 1,
        items: [{
          sessionId: "session-1",
          title: "Launch notes",
          taskId: "task-1",
          taskTitle: "Bridge search",
          archived: true,
          matchCount: 7,
          matches: [{
            sourceEventId: "event-77",
            role: "assistant",
            timestamp: "2026-09-09T18:00:00.000Z",
            snippet: "needle <img src=x onerror=alert(1)> remains plain text",
          }],
        }],
      },
      tasks: {
        total: 1,
        items: [{ taskId: "task-1", title: "Needle task", snippet: "Task notes", archived: false }],
      },
      docs: {
        total: 1,
        items: [{ path: "projects/search", title: "Search plan", snippet: "The needle contract" }],
      },
    }));
    const rendered = await render("/search?scope=task&taskId=task-1&q=needle&from=%2Ftasks%2Ftask-1");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("Launch notes") ?? false);

    expect(searchBridgeMock).toHaveBeenCalledWith(expect.objectContaining({
      q: "needle",
      scope: "task",
      taskId: "task-1",
      kind: "all",
    }), expect.any(Object));
    expect(rendered.dom.container.textContent).toContain("task:task-1");
    expect(rendered.dom.container.textContent).toContain("Archived");
    expect(rendered.dom.container.textContent).toContain("Assistant");
    expect(rendered.dom.container.textContent).toContain("Showing 1 of 7 matching messages");
    expect(rendered.dom.container.textContent).toContain("Showing 3 results");
    expect(rendered.dom.container.textContent).toContain("Tool logs, attachments, OCR");
    expect(rendered.dom.container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(findAllByTag(rendered.dom.container, "IMG")).toHaveLength(0);
    expect(findAllByTag(rendered.dom.container, "MARK").length).toBeGreaterThan(0);

    await rendered.act(async () => {
      getReactProps(findButton(rendered.dom.container, "needle <img"))?.onClick?.();
    });

    expect(rendered.dom.container.textContent).toContain(
      "/tasks/task-1/sessions/session-1?message=event-77",
    );
    expect(rendered.dom.container.textContent).toContain("from=%2Fsearch");
  });

  it("parses quoted phrases and separate terms for safe highlighting", () => {
    expect(getSearchHighlightTerms(`"exact phrase" other`)).toEqual(["exact phrase", "other"]);
  });

  it("keeps incomplete scope syntax out of requests and commits inline type chips atomically", async () => {
    vi.useFakeTimers();
    searchBridgeMock.mockResolvedValue(response());
    const rendered = await render("/search");
    const input = findAllByTag(rendered.dom.container, "INPUT")[0];
    await rendered.act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "needle task:" } });
    });
    await advanceTimersByTimeAct(rendered.act, 500);
    expect(searchBridgeMock).not.toHaveBeenCalled();
    await rendered.act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "type:task needle" } });
    });
    await advanceTimersByTimeAct(rendered.act, 500);
    expect(searchBridgeMock).toHaveBeenLastCalledWith(expect.objectContaining({ q: "needle", kind: "task" }), expect.any(Object));
    expect(rendered.dom.container.textContent).toContain("type:task");
    const chip = findAllByTag(rendered.dom.container, "BUTTON").find((node) => getReactProps(node)?.["aria-label"] === "Remove type filter");
    await rendered.act(async () => { getReactProps(chip)?.onClick?.(); });
    expect(searchBridgeMock).toHaveBeenLastCalledWith(expect.objectContaining({ q: "needle", kind: "all" }), expect.any(Object));
  });

  it("is a named floating dialog with initial focus and Tab containment", async () => {
    const rendered = await render("/search");
    const input = findAllByTag(rendered.dom.container, "INPUT")[0];
    const dialog = findAllByTag(rendered.dom.container, "DIV").find((node) => getReactProps(node)?.role === "dialog");
    expect(getReactProps(dialog)?.["aria-modal"]).toBe(true);
    expect(document.activeElement).toBe(input);
    const close = findAllByTag(dialog, "BUTTON")[0];
    const last = findAllByTag(dialog, "SUMMARY").at(-1);
    await rendered.act(async () => {
      last.focus();
      getReactProps(dialog)?.onKeyDown?.({ key: "Tab", preventDefault: vi.fn() });
    });
    expect(document.activeElement).toBe(close);
  });

  it("debounces search into a URL replace and hides stale results while the new request loads", async () => {
    vi.useFakeTimers();
    searchBridgeMock.mockResolvedValueOnce(response({
      tasks: {
        total: 1,
        items: [{ taskId: "old", title: "Old result", snippet: "old text", archived: false }],
      },
    }));
    const rendered = await render("/search?q=old&from=%2Ftasks");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("Old result") ?? false);

    let resolveNext: ((value: BridgeSearchResponse) => void) | undefined;
    searchBridgeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveNext = resolve;
    }));
    const input = findAllByTag(rendered.dom.container, "INPUT")[0];
    await rendered.act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "new terms" } });
    });

    await advanceTimersByTimeAct(rendered.act, 300);

    expect(rendered.dom.container.textContent).toContain("/search?q=new+terms");
    expect(rendered.dom.container.textContent).not.toContain("Old result");
    expect(rendered.dom.container.textContent).toContain("Searching saved Bridge content");

    await rendered.act(async () => {
      resolveNext?.(response());
    });
  });

  it("cancels pending typeahead on Escape and returns to the preserved source route", async () => {
    vi.useFakeTimers();
    searchBridgeMock.mockResolvedValue(response());
    const rendered = await render("/search?q=old&from=%2Ftasks%2Ftask-1");
    await waitUntilAct(rendered.act, () => searchBridgeMock.mock.calls.length > 0);

    const input = findAllByTag(rendered.dom.container, "INPUT")[0];
    const searchRoot = findAllByTag(rendered.dom.container, "DIV").find(
      (candidate) => getReactProps(candidate)?.["data-testid"] === "search-scroll",
    );
    await rendered.act(async () => {
      getReactProps(input)?.onChange?.({ target: { value: "pending" } });
      getReactProps(searchRoot)?.onKeyDown?.({ key: "Escape", preventDefault: vi.fn() });
    });
    await advanceTimersByTimeAct(rendered.act, 300);

    expect(rendered.dom.container.textContent).toContain("/tasks/task-1");
    expect(rendered.dom.container.textContent).not.toContain("q=pending");
  });

  it("restores the result list scroll position after opening and returning from a result", async () => {
    searchBridgeMock.mockResolvedValue(response({
      tasks: {
        total: 1,
        items: [{ taskId: "task-1", title: "Result task", snippet: "match", archived: false }],
      },
    }));
    harness = await createReactDomHarness({ installDom: installFocusDialogDom });
    await harness.render(createElement(
      MemoryRouter,
      { initialEntries: ["/search?q=match"] },
      createElement(Routes, null,
        createElement(Route, { path: "/search", element: createElement(SearchView) }),
        createElement(Route, { path: "/tasks/:taskId", element: createElement(ReturnToSearch) }),
      ),
    ));
    await waitUntilAct(harness.act, () => harness!.dom.container.textContent?.includes("Result task") ?? false);
    const firstSearchRoot = findAllByTag(harness.dom.container, "DIV").find(
      (candidate) => getReactProps(candidate)?.["data-testid"] === "search-scroll",
    );
    if (!firstSearchRoot) throw new Error("Search scroll container not found");
    Object.defineProperty(firstSearchRoot, "scrollTop", {
      configurable: true,
      writable: true,
      value: 321,
    });

    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "Result task"))?.onClick?.();
    });
    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "Return to search"))?.onClick?.();
    });
    await waitUntilAct(harness.act, () => harness!.dom.container.textContent?.includes("Result task") ?? false);
    const restoredSearchRoot = findAllByTag(harness.dom.container, "DIV").find(
      (candidate) => getReactProps(candidate)?.["data-testid"] === "search-scroll",
    );
    expect(restoredSearchRoot?.scrollTop).toBe(321);
  });

  it("waits for a delayed matching response before restoring and accepts browser scroll clamping", async () => {
    vi.useFakeTimers();
    const searchResponse = response({
      tasks: {
        total: 1,
        items: [{ taskId: "task-1", title: "Delayed task", snippet: "match", archived: false }],
      },
    });
    searchBridgeMock.mockResolvedValue(searchResponse);
    harness = await createReactDomHarness({ installDom: installFocusDialogDom });
    await harness.render(createElement(
      MemoryRouter,
      { initialEntries: ["/search?q=match"] },
      createElement(Routes, null,
        createElement(Route, { path: "/search", element: createElement(SearchView) }),
        createElement(Route, { path: "/tasks/:taskId", element: createElement(ReturnToSearch) }),
      ),
    ));
    await waitUntilAct(harness.act, () => harness!.dom.container.textContent?.includes("Delayed task") ?? false);
    const firstSearchRoot = findAllByTag(harness.dom.container, "DIV").find(
      (candidate) => getReactProps(candidate)?.["data-testid"] === "search-scroll",
    );
    if (!firstSearchRoot) throw new Error("Search scroll container not found");
    Object.defineProperty(firstSearchRoot, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });
    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "Delayed task"))?.onClick?.();
    });

    let resolveDelayed: ((value: BridgeSearchResponse) => void) | undefined;
    searchBridgeMock.mockReturnValue(new Promise((resolve) => {
      resolveDelayed = resolve;
    }));
    await harness.act(async () => {
      getReactProps(findButton(harness!.dom.container, "Return to search"))?.onClick?.();
    });
    const delayedSearchRoot = findAllByTag(harness.dom.container, "DIV").find(
      (candidate) => getReactProps(candidate)?.["data-testid"] === "search-scroll",
    );
    if (!delayedSearchRoot) throw new Error("Delayed search scroll container not found");
    Object.defineProperties(delayedSearchRoot, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });
    let clampedScrollTop = 0;
    Object.defineProperty(delayedSearchRoot, "scrollTop", {
      configurable: true,
      get: () => clampedScrollTop,
      set: (value: number) => {
        clampedScrollTop = Math.max(0, Math.min(value, 700));
      },
    });

    await advanceTimersByTimeAct(harness.act, 1_500);
    expect(clampedScrollTop).toBe(0);
    await harness.act(async () => {
      resolveDelayed?.(searchResponse);
    });
    await waitUntilAct(harness.act, () => harness!.dom.container.textContent?.includes("Delayed task") ?? false);
    await advanceTimersByTimeAct(harness.act, 0);
    expect(clampedScrollTop).toBe(700);
  });

  it("pages all matching messages in whole-chat scope using matchCount", async () => {
    searchBridgeMock.mockResolvedValue(response({
      chats: {
        total: 1,
        items: [{
          sessionId: "session-1",
          title: "Whole chat",
          archived: false,
          matchCount: 25,
          matches: Array.from({ length: 20 }, (_, index) => ({
            sourceEventId: `event-${index}`,
            role: "assistant" as const,
            snippet: `match ${index}`,
          })),
        }],
      },
    }));
    const rendered = await render("/search?scope=session&sessionId=session-1&q=match");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("Showing 1–20 of 25 matching messages") ?? false);

    const next = findButton(rendered.dom.container, "Next");
    expect(getReactProps(next)?.disabled).toBe(false);
    await rendered.act(async () => {
      getReactProps(next)?.onClick?.();
    });
    expect(rendered.dom.container.textContent).toContain("offset=20");
  });

  it("labels title-only hits and opens read-only saved history without inventing a message target", async () => {
    searchBridgeMock.mockResolvedValue(response({
      chats: {
        total: 1,
        items: [{
          sessionId: "session-title",
          title: "Remembered project name",
          archived: false,
          matches: [],
          matchCount: 0,
        }],
      },
    }));
    const rendered = await render("/search?q=remembered");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("Title match") ?? false);

    expect(rendered.dom.container.textContent).toContain("no matching message text");
    await rendered.act(async () => {
      getReactProps(findButton(rendered.dom.container, "Remembered project name"))?.onClick?.();
    });
    expect(rendered.dom.container.textContent).toContain("/sessions/session-title?history=1");
    expect(rendered.dom.container.textContent).not.toContain("message=");
  });

  it("discloses partial coverage and source errors separately from no matches", async () => {
    searchBridgeMock.mockResolvedValue(response({
      coverage: {
        state: "partial",
        indexedSessions: 2,
        totalSessions: 5,
        errors: ["Docs index unavailable"],
      },
    }));
    const rendered = await render("/search?q=missing");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("coverage is partial") ?? false);

    expect(rendered.dom.container.textContent).toContain("2 of 5 chats indexed");
    expect(rendered.dom.container.textContent).toContain("Docs index unavailable");
    expect(rendered.dom.container.textContent).toContain("No matches in the searched coverage");
  });

  it("shows request failures as errors instead of empty results", async () => {
    searchBridgeMock.mockRejectedValue(new Error("search service failed"));
    const rendered = await render("/search?q=needle");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("search service failed") ?? false);

    expect(findAllByTag(rendered.dom.container, "DIV").some((node) => getReactProps(node)?.role === "alert")).toBe(true);
    expect(rendered.dom.container.textContent).not.toContain("No matches in the searched coverage");
  });

  it("refreshes indexing coverage at low frequency while preserving results and stops when ready", async () => {
    vi.useFakeTimers();
    const indexing = response({
      tasks: {
        total: 1,
        items: [{ taskId: "task-1", title: "Indexed so far", snippet: "partial result", archived: false }],
      },
      coverage: {
        state: "indexing",
        indexedSessions: 10,
        totalSessions: 100,
        errors: [],
      },
    });
    const ready = response({
      tasks: {
        total: 1,
        items: [{ taskId: "task-1", title: "Complete result", snippet: "ready result", archived: false }],
      },
    });
    searchBridgeMock.mockResolvedValueOnce(indexing);
    let resolveRefresh: ((value: BridgeSearchResponse) => void) | undefined;
    searchBridgeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const rendered = await render("/search?q=result");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("Indexed so far") ?? false);

    await advanceTimersByTimeAct(rendered.act, 1_999);
    expect(searchBridgeMock).toHaveBeenCalledTimes(1);
    await advanceTimersByTimeAct(rendered.act, 1);
    expect(searchBridgeMock).toHaveBeenCalledTimes(2);
    expect(rendered.dom.container.textContent).toContain("Indexed so far");
    expect(rendered.dom.container.textContent).toContain("Searching saved Bridge content");

    await rendered.act(async () => {
      resolveRefresh?.(ready);
    });
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("Complete result") ?? false);
    await advanceTimersByTimeAct(rendered.act, 4_000);
    expect(searchBridgeMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes partial coverage while reconciling, then stops even when failures remain", async () => {
    vi.useFakeTimers();
    const partial = response({
      coverage: { state: "partial", reconciling: true, indexedSessions: 2, totalSessions: 5, errors: ["Malformed log"] },
    });
    searchBridgeMock.mockResolvedValueOnce(partial).mockResolvedValueOnce(response({
      coverage: { ...partial.coverage, reconciling: false, indexedSessions: 4 },
    }));
    const rendered = await render("/search?q=needle");
    await waitUntilAct(rendered.act, () => rendered.dom.container.textContent?.includes("2 of 5") ?? false);
    expect(rendered.dom.container.textContent).toContain("indexing is still in progress");
    await advanceTimersByTimeAct(rendered.act, 2_000);
    expect(searchBridgeMock).toHaveBeenLastCalledWith(expect.objectContaining({ refreshOnly: true }), expect.any(Object));
    expect(rendered.dom.container.textContent).toContain("4 of 5");
    expect(rendered.dom.container.textContent).toContain("Malformed log");
    expect(rendered.dom.container.textContent).not.toContain("indexing is still in progress");
    await advanceTimersByTimeAct(rendered.act, 6_000);
    expect(searchBridgeMock).toHaveBeenCalledTimes(2);
    const input = findAllByTag(rendered.dom.container, "INPUT")[0];
    await rendered.act(async () => { getReactProps(input)?.onChange?.({ target: { value: "new query" } }); });
    searchBridgeMock.mockResolvedValue(response());
    await advanceTimersByTimeAct(rendered.act, 300);
    expect(searchBridgeMock).toHaveBeenLastCalledWith(expect.objectContaining({ q: "new query", refreshOnly: false }), expect.any(Object));
  });
});

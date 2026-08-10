import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { buildOptimisticSessionModelState } from "../lib/session-model";
import SessionModelSummary from "./SessionModelSummary";

describe("buildOptimisticSessionModelState", () => {
  it("reflects explicit draft choices without inventing inherited overrides", () => {
    expect(buildOptimisticSessionModelState({
      model: "gpt-5-mini",
      reasoningEffort: "high",
    }, "claude-haiku-4.5")).toEqual({
      model: "gpt-5-mini",
      reasoningEffort: "high",
      source: "unknown",
    });
  });

  it("uses the known global model only for the optimistic display", () => {
    expect(buildOptimisticSessionModelState({}, "claude-haiku-4.5")).toEqual({
      model: "claude-haiku-4.5",
      source: "unknown",
    });
    expect(buildOptimisticSessionModelState({})).toBeUndefined();
  });
});

describe("SessionModelSummary", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(async () => {
    harness = await createReactDomHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("announces the effective model, effort, and context compactly", async () => {
    await harness!.render(createElement(SessionModelSummary, {
      state: {
        model: "gpt-5.6",
        reasoningEffort: "high",
        contextTier: "long_context",
        source: "live",
      },
      models: [{
        id: "gpt-5.6",
        name: "GPT-5.6",
        capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
        billing: { tokenPrices: { contextMax: 272_000, longContext: { contextMax: 922_000 } } },
      }],
      loading: false,
      onRetry: vi.fn(),
    }));

    expect(harness!.dom.container.textContent).toBe("GPT-5.6 · High · Long context (922K)");
    const summary = findAllByTag(harness!.dom.container, "DIV")
      .find((element) => getReactProps(element)?.role === "group");
    expect(getReactProps(summary)?.["aria-label"]).toBe(
      "Session configuration: GPT-5.6 · High · Long context (922K)",
    );
  });

  it("names inherited values as defaults instead of implying an explicit override", async () => {
    await harness!.render(createElement(SessionModelSummary, {
      state: { model: "claude-sonnet-5", source: "events" },
      models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      loading: false,
      onRetry: vi.fn(),
    }));

    expect(harness!.dom.container.textContent).toBe(
      "Claude Sonnet 5 · Default effort · Default context",
    );
  });

  it("does not label an unknown lookup as the default model", async () => {
    await harness!.render(createElement(SessionModelSummary, {
      state: { source: "unknown" },
      loading: false,
      onRetry: vi.fn(),
    }));

    expect(harness!.dom.container.textContent).toBe(
      "Model unavailable · Default effort · Default context",
    );
  });

  it("shows a retry action when the state cannot be loaded", async () => {
    const onRetry = vi.fn();
    await harness!.render(createElement(SessionModelSummary, {
      loading: false,
      error: "network failed",
      onRetry,
    }));

    const retry = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    await harness!.act(async () => {
      getReactProps(retry)?.onClick?.();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps stale data visible while exposing a failed-refresh retry", async () => {
    const onRetry = vi.fn();
    await harness!.render(createElement(SessionModelSummary, {
      state: { model: "gpt-5.6", source: "live" },
      models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
      loading: false,
      error: "refresh failed",
      onRetry,
    }));

    expect(harness!.dom.container.textContent).toContain(
      "GPT-5.6 · Default effort · Default context",
    );
    const retry = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    expect(getReactProps(retry)?.title).toBe("refresh failed");
  });
});

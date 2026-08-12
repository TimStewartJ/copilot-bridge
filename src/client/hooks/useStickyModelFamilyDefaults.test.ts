import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, type ReactDomHarness } from "../test-react-harness";
import { queryClient, queryKeys } from "../queryClient";
import type { AppSettings } from "../api";
import { useStickyModelFamilyDefaults } from "./useStickyModelFamilyDefaults";

describe("useStickyModelFamilyDefaults", () => {
  let harness: ReactDomHarness | null = null;
  let remember: ReturnType<typeof useStickyModelFamilyDefaults> | null = null;

  beforeEach(async () => {
    harness = await createReactDomHarness();
    queryClient.setQueryData<AppSettings>(queryKeys.settings, {
      mcpServers: {},
      familyDefaults: { gpt: { model: "gpt-5.6" } },
      lastModelFamily: "gpt",
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({ mcpServers: {}, ...body }),
      };
    }));
  });

  afterEach(async () => {
    remember = null;
    queryClient.removeQueries({ queryKey: queryKeys.settings });
    vi.unstubAllGlobals();
    await harness?.cleanup();
    harness = null;
  });

  function TestComponent() {
    remember = useStickyModelFamilyDefaults();
    return null;
  }

  it("merges rapid family choices before persisting them", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      remember?.({ modelId: "gpt-5-mini", reasoningEffort: "high" });
      remember?.({ modelId: "claude-opus-5", contextTier: "long_context" });
    });

    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({
      familyDefaults: {
        gpt: { model: "gpt-5-mini", reasoningEffort: "high" },
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toMatchObject({
      familyDefaults: {
        gpt: { model: "gpt-5-mini", reasoningEffort: "high" },
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });
  });
});

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../../test-react-harness";
import { ProvidersSection } from "./ProvidersSection";

function findRemoveButton(root: any): any {
  const button = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.title === "Remove",
  );
  if (!button) throw new Error("Remove button not found");
  return button;
}

function createDraft(): AppSettings {
  return {
    mcpServers: {},
    providers: { ado: { org: "my-org", project: "MyProject" } },
  };
}

describe("ProvidersSection remove confirmation", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(() => {
    harness = undefined;
    vi.restoreAllMocks();
  });

  async function renderSection(confirmResult: boolean) {
    const confirmSpy = vi.fn(() => confirmResult);
    const setDraft = vi.fn();
    harness = await createReactDomHarness();
    (globalThis.window as unknown as { confirm: () => boolean }).confirm = confirmSpy;
    await harness.render(
      createElement(ProvidersSection, { draft: createDraft(), setDraft }),
    );
    return { confirmSpy, setDraft };
  }

  it("removes a configured provider only after the user confirms", async () => {
    const { confirmSpy, setDraft } = await renderSection(true);
    const button = findRemoveButton(harness!.dom.container);
    await harness!.act(async () => {
      await getReactProps(button)?.onClick?.({});
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("Remove Azure DevOps provider configuration?"),
    );
    expect(setDraft).toHaveBeenCalledTimes(1);
    const next = setDraft.mock.calls[0][0] as AppSettings;
    expect(next.providers).toBeUndefined();
  });

  it("keeps the provider when the user cancels the confirmation", async () => {
    const { confirmSpy, setDraft } = await renderSection(false);
    const button = findRemoveButton(harness!.dom.container);
    await harness!.act(async () => {
      await getReactProps(button)?.onClick?.({});
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(setDraft).not.toHaveBeenCalled();
  });
});

describe("ProvidersSection GitHub defaults badge", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(() => {
    harness = undefined;
    vi.restoreAllMocks();
  });

  async function renderProviders(providers: AppSettings["providers"]): Promise<string> {
    harness = await createReactDomHarness();
    await harness.render(
      createElement(ProvidersSection, {
        draft: { mcpServers: {}, providers },
        setDraft: vi.fn(),
      }),
    );
    return harness.dom.container.textContent ?? "";
  }

  it("says defaults are missing without claiming GitHub is unusable", async () => {
    const text = await renderProviders(undefined);

    expect(text).toContain("no defaults");
    expect(text).not.toContain("defaults set");
    // Only the ADO and Linear cards use the configured/not-configured badge.
    expect(text.match(/not configured/g)?.length).toBe(2);
    expect(text).toContain("owner/repo#123");
    expect(text).toContain("link without configuration");
  });

  it("says defaults are set once an owner is configured", async () => {
    const text = await renderProviders({ github: { owner: "microsoft" } });

    expect(text).toContain("defaults set");
    expect(text).not.toContain("no defaults");
    expect(text).toContain("microsoft");
    expect(text).toContain("link without configuration");
  });
});

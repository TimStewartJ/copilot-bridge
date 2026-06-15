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

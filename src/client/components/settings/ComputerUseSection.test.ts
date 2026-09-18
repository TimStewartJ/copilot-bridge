import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchComputerUseStatus: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...apiMocks,
}));

const { ComputerUseSection } = await import("./ComputerUseSection");

describe("ComputerUseSection", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    apiMocks.fetchComputerUseStatus.mockReset();
  });

  async function renderSection(draft: AppSettings, setDraft = vi.fn()) {
    harness = await createReactDomHarness();
    await harness.render(createElement(ComputerUseSection, { draft, setDraft }));
    return { container: harness.dom.container, setDraft, harness };
  }

  it("shows the installed plugin version and toggles the shared draft", async () => {
    apiMocks.fetchComputerUseStatus.mockResolvedValue({ enabled: false, available: true, version: "0.1.88" });
    const draft: AppSettings = { mcpServers: {} };
    const { container, setDraft, harness: rendered } = await renderSection(draft);

    await waitUntilAct(rendered.act, () => container.textContent?.includes("0.1.88") === true);
    const [checkbox] = findAllByTag(container, "INPUT");
    expect(getReactProps(checkbox)?.checked).toBe(false);
    expect(getReactProps(checkbox)?.disabled).toBe(false);

    await rendered.act(async () => {
      getReactProps(checkbox)?.onChange?.({ target: { checked: true } });
    });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, computerUse: { enabled: true } });
  });

  it("clears the setting when turned off", async () => {
    apiMocks.fetchComputerUseStatus.mockResolvedValue({ enabled: true, available: true, version: "0.1.88" });
    const draft: AppSettings = { mcpServers: {}, computerUse: { enabled: true } };
    const { container, setDraft, harness: rendered } = await renderSection(draft);

    const [checkbox] = findAllByTag(container, "INPUT");
    expect(getReactProps(checkbox)?.checked).toBe(true);
    await rendered.act(async () => {
      getReactProps(checkbox)?.onChange?.({ target: { checked: false } });
    });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, computerUse: undefined });
  });

  it("explains why it cannot be turned on when the SDK ships no plugin", async () => {
    apiMocks.fetchComputerUseStatus.mockResolvedValue({
      enabled: false,
      available: false,
      reason: "The Copilot SDK platform package (@github/copilot-sdk-linux-x64) is not installed.",
    });
    const { container, harness: rendered } = await renderSection({ mcpServers: {} });

    await waitUntilAct(rendered.act, () => container.textContent?.includes("is not installed") === true);
    const [checkbox] = findAllByTag(container, "INPUT");
    expect(getReactProps(checkbox)?.disabled).toBe(true);
  });
});

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
  installCuaDriver: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...apiMocks,
}));

const { ComputerUseSection } = await import("./ComputerUseSection");

const pluginOnly = (plugin: { available: boolean; version?: string; reason?: string }) => ({
  enabled: false,
  engine: "github",
  awayAfterMinutes: 3,
  plugin,
  cua: { supported: false, installed: false, version: "0.49.5", installing: false },
});

describe("ComputerUseSection", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    apiMocks.fetchComputerUseStatus.mockReset();
    apiMocks.installCuaDriver.mockReset();
  });

  async function renderSection(draft: AppSettings, setDraft = vi.fn()) {
    harness = await createReactDomHarness();
    await harness.render(createElement(ComputerUseSection, { draft, setDraft }));
    return { container: harness.dom.container, setDraft, harness };
  }

  it("toggles the installed plugin on and clears its setting when switched back off", async () => {
    apiMocks.fetchComputerUseStatus.mockResolvedValue(pluginOnly({ available: true, version: "0.1.88" }));
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

    await rendered.render(createElement(ComputerUseSection, { draft: setDraft.mock.calls[0]![0], setDraft }));
    expect(getReactProps(checkbox)?.checked).toBe(true);
    await rendered.act(async () => {
      getReactProps(checkbox)?.onChange?.({ target: { checked: false } });
    });
    expect(setDraft).toHaveBeenLastCalledWith({ ...draft, computerUse: undefined });
  });

  it("explains why it cannot be turned on when the SDK ships no plugin", async () => {
    apiMocks.fetchComputerUseStatus.mockResolvedValue(pluginOnly({
      available: false,
      reason: "The Copilot SDK platform package (@github/copilot-sdk-linux-x64) is not installed.",
    }));
    const { container, harness: rendered } = await renderSection({ mcpServers: {} });

    await waitUntilAct(rendered.act, () => container.textContent?.includes("is not installed") === true);
    const [checkbox] = findAllByTag(container, "INPUT");
    expect(getReactProps(checkbox)?.disabled).toBe(true);
  });

  it("offers to install Cua Driver when it is the engine and missing", async () => {
    const missing = {
      enabled: true,
      engine: "cua",
      awayAfterMinutes: 3,
      plugin: { available: true, version: "0.1.97" },
      cua: { supported: true, installed: false, version: "0.49.5", installing: false },
    };
    apiMocks.fetchComputerUseStatus.mockResolvedValue(missing);
    apiMocks.installCuaDriver.mockResolvedValue({ ...missing, cua: { ...missing.cua, installing: true } });
    const { container, harness: rendered } = await renderSection({ mcpServers: {}, computerUse: { enabled: true } });

    await waitUntilAct(rendered.act, () => container.textContent?.includes("Install") === true);
    const install = findAllByTag(container, "BUTTON").find((button) => button.textContent === "Install")!;
    await rendered.act(async () => {
      getReactProps(install)?.onClick?.({});
    });
    expect(apiMocks.installCuaDriver).toHaveBeenCalledOnce();
    await waitUntilAct(rendered.act, () => container.textContent?.includes("Installing…") === true);
  });
});

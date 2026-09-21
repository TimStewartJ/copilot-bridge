import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "./test-react-harness";
import { installDomShim } from "./test-dom-shim";
import { ThemeProvider, useTheme } from "./useTheme";
import { AppearanceSection } from "./components/settings/AppearanceSection";
import type { AppSettings } from "./api";

const state = vi.hoisted(() => ({
  settings: { theme: "dark", mcpServers: {} },
  patch: vi.fn(),
  hasData: true,
  error: null as Error | null,
  refetch: vi.fn(),
}));
vi.mock("./hooks/queries/useSettings", () => ({ useSettingsQuery: () => ({ data: state.hasData ? state.settings : undefined, error: state.error, refetch: state.refetch }) }));
vi.mock("./api", () => ({ patchSettings: state.patch }));

function Probe() {
  const { theme, savedTheme, previewTheme } = useTheme();
  return createElement("div", null,
    createElement("output", null, `${theme}/${savedTheme}`),
    createElement("button", { onClick: () => previewTheme("light") }, "Preview"),
    createElement("button", { onClick: () => previewTheme(null) }, "Restore"),
  );
}

describe("reversible theme drafts", () => {
  let harness: ReactDomHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    state.settings = { theme: "dark", mcpServers: {} };
    state.patch.mockClear();
    state.hasData = true;
    state.error = null;
    state.refetch.mockClear();
  });

  async function render() {
    harness ??= await createReactDomHarness({ installDom: () => {
      const dom = installDomShim();
      Object.defineProperty(document, "querySelector", { configurable: true, value: () => null });
      Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
      return dom;
    } });
    await harness.render(createElement(ThemeProvider, null, createElement(Probe)));
  }

  async function click(text: string) {
    const button = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent === text);
    await harness!.act(async () => { getReactProps(button)?.onClick?.(); });
  }

  it("previews locally and restores without writing settings", async () => {
    await render();
    await click("Preview");
    expect(harness!.dom.container.textContent).toContain("light/dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(state.patch).not.toHaveBeenCalled();
    await click("Restore");
    expect(harness!.dom.container.textContent).toContain("dark/dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("offers a retry rather than hiding the whole app on an initial settings failure", async () => {
    state.hasData = false;
    state.error = new Error("Preferences unavailable");
    await render();
    expect(harness!.dom.container.textContent).toContain("Bridge preferences could not load");
    await click("Retry");
    expect(state.refetch).toHaveBeenCalledOnce();
    state.hasData = true;
    state.error = null;
    await render();
    expect(harness!.dom.container.textContent).toContain("dark/dark");
  });

  it("preserves a preview through unrelated reads and uses the saved result on release", async () => {
    await render();
    await click("Preview");
    state.settings = { ...state.settings };
    await render();
    expect(harness!.dom.container.textContent).toContain("light/dark");
    state.settings = { ...state.settings, theme: "light" };
    await render();
    await click("Restore");
    expect(harness!.dom.container.textContent).toContain("light/light");
    expect(state.patch).not.toHaveBeenCalled();
  });

  it("releases the Appearance preview when its draft is discarded or the settings view closes", async () => {
    await render();
    const saved: AppSettings = { mcpServers: {}, theme: "dark" };
    const setDraft = vi.fn();
    const appearance = (draft: AppSettings) => createElement(ThemeProvider, null, createElement(AppearanceSection, { draft, setDraft }));
    await harness!.render(appearance(saved));
    const light = findAllByTag(harness!.dom.container, "BUTTON").find((node) => node.textContent === "Light");
    await harness!.act(async () => { getReactProps(light)?.onClick?.(); });
    expect(setDraft).toHaveBeenCalledWith({ ...saved, theme: "light" });
    await harness!.render(appearance({ ...saved, theme: "light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await harness!.render(appearance(saved));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await harness!.render(appearance({ ...saved, theme: "light" }));
    await render();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(state.patch).not.toHaveBeenCalled();
  });
});

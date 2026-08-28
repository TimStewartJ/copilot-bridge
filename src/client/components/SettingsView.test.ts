import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../api";
import { LAST_SETTINGS_CATEGORY_KEY } from "../lib/settings-routes";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";

const settingsMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  useSettingsMutation: vi.fn(),
  useSettingsQuery: vi.fn(),
  useTagsQuery: vi.fn(),
  mcpServersSection: vi.fn(),
  settingsCategoryNav: vi.fn(),
}));

vi.mock("../hooks/queries/useSettings", () => ({
  useSettingsMutation: () => settingsMocks.useSettingsMutation(),
  useSettingsQuery: () => settingsMocks.useSettingsQuery(),
}));

vi.mock("../hooks/queries/useTags", () => ({
  useTagsQuery: () => settingsMocks.useTagsQuery(),
}));

vi.mock("./settings", () => {
  const EmptySection = () => null;
  return {
    AppearanceSection: EmptySection,
    BridgeCommitsSection: EmptySection,
    BrowserDiagnosticsSection: EmptySection,
    CopilotUsageSection: EmptySection,
    DeviceManagementSection: EmptySection,
    ManagementJobsSection: EmptySection,
    ModelSection: EmptySection,
    NotificationsSection: EmptySection,
    ProvidersSection: ({
      draft,
      setDraft,
    }: {
      draft: AppSettings;
      setDraft: (draft: AppSettings) => void;
    }) => createElement(
      "button",
      {
        onClick: () => setDraft({
          ...draft,
          identity: `${draft.identity ?? "saved"}-changed`,
        }),
      },
      "Change settings",
    ),
    ReasoningEffortSection: EmptySection,
    SettingsCategoryNav: (props: {
      activeCategory: string;
      onSelectCategory: (category: string) => void;
    }) => {
      settingsMocks.settingsCategoryNav(props);
      return null;
    },
    SystemPromptSection: EmptySection,
    TagsSection: EmptySection,
    UpdatesSection: EmptySection,
    VoiceInputSection: EmptySection,
  };
});

vi.mock("./settings/McpServersSection", () => ({
  McpServersSection: (props: { resetSignal: number }) => {
    settingsMocks.mcpServersSection(props);
    return null;
  },
}));

vi.mock("./settings/SkillsSection", () => ({
  SkillsSection: () => null,
}));

const { default: SettingsView } = await import("./SettingsView");

const savedSettings: AppSettings = {
  identity: "saved",
  mcpServers: {},
};

function stubLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

function buttonsWithText(root: any, text: string): any[] {
  return findAllByTag(root, "BUTTON").filter((button) => button.textContent === text);
}

function buttonWithText(root: any, text: string): any {
  const matches = buttonsWithText(root, text);
  if (matches.length !== 1) {
    throw new Error(`Expected one "${text}" button, found ${matches.length}`);
  }
  return matches[0];
}

function feedbackWithRole(root: any, role: "alert" | "status"): any {
  const feedback = findAllByTag(root, "DIV").find(
    (element) => getReactProps(element)?.role === role,
  );
  if (!feedback) throw new Error(`Feedback with role "${role}" not found`);
  return feedback;
}

async function renderSettingsView(
  initialEntry = "/settings?group=integrations",
): Promise<ReactDomHarness> {
  const harness = await createReactDomHarness();
  await harness.render(
    createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      createElement(SettingsView),
    ),
  );
  await waitUntilAct(
    harness.act,
    () => settingsMocks.settingsCategoryNav.mock.calls.length > 0,
    { label: "settings category navigation" },
  );
  return harness;
}

async function makeSettingsDirty(harness: ReactDomHarness): Promise<void> {
  const changeButton = buttonWithText(harness.dom.container, "Change settings");
  await harness.act(async () => {
    getReactProps(changeButton)?.onClick?.({ detail: 0 });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  stubLocalStorage();
  settingsMocks.mutateAsync.mockReset();
  settingsMocks.mutateAsync.mockImplementation(async (settings: AppSettings) => settings);
  settingsMocks.useSettingsMutation.mockReset();
  settingsMocks.useSettingsMutation.mockReturnValue({
    mutateAsync: settingsMocks.mutateAsync,
  });
  settingsMocks.useSettingsQuery.mockReset();
  settingsMocks.useSettingsQuery.mockReturnValue({
    data: savedSettings,
    isLoading: false,
  });
  settingsMocks.useTagsQuery.mockReset();
  settingsMocks.useTagsQuery.mockReturnValue({ data: [] });
  settingsMocks.mcpServersSection.mockReset();
  settingsMocks.settingsCategoryNav.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsView category persistence", () => {
  it("restores the last category when settings is reopened without a group", async () => {
    localStorage.setItem(LAST_SETTINGS_CATEGORY_KEY, "diagnostics");

    await renderSettingsView("/settings");

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe(
      "diagnostics",
    );
  });

  it("remembers category changes across mounts", async () => {
    const harness = await renderSettingsView();
    const categoryNavProps = settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0];
    if (!categoryNavProps) throw new Error("Settings category nav was not rendered");

    await harness.act(async () => {
      categoryNavProps.onSelectCategory("usage");
    });
    await waitUntilAct(
      harness.act,
      () => settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory === "usage",
      { label: "usage settings category" },
    );

    expect(localStorage.getItem(LAST_SETTINGS_CATEGORY_KEY)).toBe("usage");

    await harness.cleanup();
    settingsMocks.settingsCategoryNav.mockClear();
    const reopenedHarness = await renderSettingsView("/settings");

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe(
      "usage",
    );

    const reopenedCategoryNavProps = settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0];
    if (!reopenedCategoryNavProps) throw new Error("Reopened settings category nav was not rendered");
    await reopenedHarness.act(async () => {
      reopenedCategoryNavProps.onSelectCategory("general");
    });

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe(
      "general",
    );
    expect(localStorage.getItem(LAST_SETTINGS_CATEGORY_KEY)).toBe("general");
  });
});

describe("SettingsView save controls", () => {
  it("shows one native action pair and discards the draft with the MCP reset signal", async () => {
    const harness = await renderSettingsView();
    await makeSettingsDirty(harness);

    expect(buttonsWithText(harness.dom.container, "Discard")).toHaveLength(1);
    expect(buttonsWithText(harness.dom.container, "Save")).toHaveLength(1);

    const discardButton = buttonWithText(harness.dom.container, "Discard");
    expect(discardButton.tagName).toBe("BUTTON");
    await harness.act(async () => {
      getReactProps(discardButton)?.onClick?.({ detail: 0 });
    });

    expect(buttonsWithText(harness.dom.container, "Discard")).toHaveLength(0);
    expect(buttonsWithText(harness.dom.container, "Save")).toHaveLength(0);
    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
    expect(settingsMocks.mcpServersSection.mock.calls.at(-1)?.[0]).toEqual({
      resetSignal: 1,
    });
  });

  it("disables the sole save action while pending and announces success", async () => {
    let resolveSave: ((settings: AppSettings) => void) | undefined;
    settingsMocks.mutateAsync.mockReturnValueOnce(new Promise<AppSettings>((resolve) => {
      resolveSave = resolve;
    }));
    const harness = await renderSettingsView();
    await makeSettingsDirty(harness);

    const saveButton = buttonWithText(harness.dom.container, "Save");
    let savePromise: Promise<void> | undefined;
    await harness.act(async () => {
      savePromise = getReactProps(saveButton)?.onClick?.({ detail: 0 });
      await Promise.resolve();
    });

    const savingButton = buttonWithText(harness.dom.container, "Saving…");
    expect(buttonsWithText(harness.dom.container, "Discard")).toHaveLength(1);
    expect(getReactProps(savingButton)?.disabled).toBe(true);
    expect(settingsMocks.mutateAsync).toHaveBeenCalledTimes(1);

    const submittedSettings = settingsMocks.mutateAsync.mock.calls[0][0] as AppSettings;
    const completeSave = resolveSave;
    const pendingSave = savePromise;
    if (!completeSave || !pendingSave) throw new Error("Pending save was not initialized");
    await harness.act(async () => {
      completeSave(submittedSettings);
      await pendingSave;
    });

    expect(buttonsWithText(harness.dom.container, "Discard")).toHaveLength(0);
    expect(buttonsWithText(harness.dom.container, "Save")).toHaveLength(0);
    const feedback = feedbackWithRole(harness.dom.container, "status");
    expect(getReactProps(feedback)?.["aria-live"]).toBe("polite");
    expect(feedback.textContent).toBe("Settings saved");
  });

  it("keeps the action pair available and announces a failed save", async () => {
    settingsMocks.mutateAsync.mockRejectedValueOnce(new Error("offline"));
    const harness = await renderSettingsView();
    await makeSettingsDirty(harness);

    const saveButton = buttonWithText(harness.dom.container, "Save");
    await harness.act(async () => {
      await getReactProps(saveButton)?.onClick?.({ detail: 0 });
    });

    expect(buttonsWithText(harness.dom.container, "Discard")).toHaveLength(1);
    expect(buttonsWithText(harness.dom.container, "Save")).toHaveLength(1);
    expect(getReactProps(buttonWithText(harness.dom.container, "Save"))?.disabled).toBe(false);
    expect(feedbackWithRole(harness.dom.container, "alert").textContent).toBe(
      "Save failed: offline",
    );
  });
});

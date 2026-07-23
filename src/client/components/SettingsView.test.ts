import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../api";
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
    SettingsCategoryNav: EmptySection,
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

async function renderSettingsView(): Promise<ReactDomHarness> {
  const harness = await createReactDomHarness();
  await harness.render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/settings?group=integrations"] },
      createElement(SettingsView),
    ),
  );
  await waitUntilAct(
    harness.act,
    () => (harness.dom.container.textContent ?? "").includes("Change settings"),
    { label: "settings draft controls" },
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

import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AppSettings, type AppSettingsUpdates } from "../api";
import { createSettingsWriter } from "../lib/settings-writer";
import { LAST_SETTINGS_CATEGORY_KEY } from "../lib/settings-routes";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";

const settingsMocks = vi.hoisted(() => ({
  patch: vi.fn(),
  useSettingsQuery: vi.fn(),
  useTagsQuery: vi.fn(),
  settingsCategoryNav: vi.fn(),
  location: vi.fn(),
}));

/** A real settings writer in front of a fake server, recreated for every test. */
const writerHost = vi.hoisted(() => ({
  writer: null as null | import("../lib/settings-writer").SettingsWriter,
  cache: undefined as AppSettings | undefined,
}));

vi.mock("../hooks/queries/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  const current = () => {
    if (!writerHost.writer) throw new Error("Settings writer not created");
    return writerHost.writer;
  };
  return {
    useSettingsQuery: () => settingsMocks.useSettingsQuery(),
    settingsWriter: {
      update: (recipe: Parameters<import("../lib/settings-writer").SettingsWriter["update"]>[0]) => current().update(recipe),
      undo: () => current().undo(),
      retry: () => current().retry(),
      dismissError: () => current().dismissError(),
    },
    useSettingsWriter: () => useSyncExternalStore(
      (listener: () => void) => current().subscribe(listener),
      () => current().getSnapshot(),
    ),
  };
});

vi.mock("../hooks/queries/useTags", () => ({
  useTagsQuery: () => settingsMocks.useTagsQuery(),
}));

vi.mock("./settings", () => {
  const EmptySection = () => null;
  return {
    AppearanceSection: EmptySection,
    BridgeCommitsSection: EmptySection,
    BrowserDiagnosticsSection: EmptySection,
    ComputerUseSection: EmptySection,
    CopilotUsageSection: EmptySection,
    DeviceManagementSection: EmptySection,
    DeferWorkerSection: EmptySection,
    ManagementJobsSection: EmptySection,
    BridgeRuntimeSection: EmptySection,
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
    SpeechEngineSection: EmptySection,
  };
});

vi.mock("./settings/McpServersSection", () => ({
  McpServersSection: () => null,
}));

vi.mock("./settings/SkillsSection", () => ({
  SkillsSection: () => null,
}));

vi.mock("./CopilotQuotaMenu", () => ({
  CopilotQuotaCard: () => null,
}));

const { default: SettingsView } = await import("./SettingsView");

const savedSettings: AppSettings = {
  identity: "saved",
  mcpServers: {},
};

let server: AppSettings = savedSettings;

function createWriter(initial: AppSettings | undefined) {
  server = initial ? structuredClone(initial) : savedSettings;
  writerHost.cache = initial ? structuredClone(initial) : undefined;
  writerHost.writer = createSettingsWriter({
    patch: (updates: AppSettingsUpdates) => settingsMocks.patch(updates),
    fetch: async () => structuredClone(server),
    readCache: () => writerHost.cache,
    writeCache: (settings) => { writerHost.cache = settings; },
    subscribeCache: () => () => undefined,
  });
}

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

function LocationProbe() {
  settingsMocks.location(useLocation().search);
  return null;
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
      createElement(LocationProbe),
    ),
  );
  await waitUntilAct(
    harness.act,
    () => settingsMocks.settingsCategoryNav.mock.calls.length > 0,
    { label: "settings category navigation" },
  );
  return harness;
}

async function changeSettings(harness: ReactDomHarness): Promise<void> {
  const changeButton = buttonWithText(harness.dom.container, "Change settings");
  await harness.act(async () => {
    getReactProps(changeButton)?.onClick?.({ detail: 0 });
  });
}

function heldPatch() {
  let resolve!: (settings: AppSettings) => void;
  let reject!: (error: unknown) => void;
  settingsMocks.patch.mockImplementationOnce((updates: AppSettingsUpdates) => new Promise<AppSettings>((res, rej) => {
    resolve = (settings) => res(settings ?? { ...server, ...updates });
    reject = rej;
  }));
  return { resolve: (settings?: AppSettings) => resolve(settings as AppSettings), reject: (error: unknown) => reject(error) };
}

beforeEach(() => {
  stubLocalStorage();
  settingsMocks.patch.mockReset();
  settingsMocks.patch.mockImplementation(async (updates: AppSettingsUpdates) => {
    server = { ...server, ...updates };
    return structuredClone(server);
  });
  settingsMocks.useSettingsQuery.mockReset();
  settingsMocks.useSettingsQuery.mockReturnValue({
    data: savedSettings,
    isLoading: false,
  });
  settingsMocks.useTagsQuery.mockReset();
  settingsMocks.useTagsQuery.mockReturnValue({ data: [] });
  settingsMocks.settingsCategoryNav.mockReset();
  settingsMocks.location.mockReset();
  createWriter(savedSettings);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsView categories", () => {
  it("restores the last category when settings is reopened without a group", async () => {
    localStorage.setItem(LAST_SETTINGS_CATEGORY_KEY, "voice");

    await renderSettingsView("/settings");

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe("voice");
  });

  it("opens a remembered retired category on the page that replaced it", async () => {
    localStorage.setItem(LAST_SETTINGS_CATEGORY_KEY, "general");

    await renderSettingsView("/settings");

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe("chat");
  });

  it.each([
    ["diagnostics", "browser"],
    ["management", "jobs"],
    ["updates", "updates"],
  ])("sends an old ?group=%s link to the %s part of System", async (group, section) => {
    const harness = await renderSettingsView(`/settings?group=${group}`);
    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe("system");
    await waitUntilAct(harness.act, () => {
      const search = new URLSearchParams(settingsMocks.location.mock.calls.at(-1)?.[0] ?? "");
      return search.get("group") === "system" && search.get("section") === section;
    }, { label: "canonical system link" });
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

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe("usage");

    const reopenedCategoryNavProps = settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0];
    if (!reopenedCategoryNavProps) throw new Error("Reopened settings category nav was not rendered");
    await reopenedHarness.act(async () => {
      reopenedCategoryNavProps.onSelectCategory("chat");
    });

    expect(settingsMocks.settingsCategoryNav.mock.calls.at(-1)?.[0].activeCategory).toBe("chat");
    expect(localStorage.getItem(LAST_SETTINGS_CATEGORY_KEY)).toBe("chat");
  });

  it("keeps a pending tag query stable instead of copying a new empty array into state on every render", async () => {
    settingsMocks.useTagsQuery.mockReturnValue({ data: undefined, isLoading: true });
    const harness = await renderSettingsView("/settings?group=tags");
    expect(harness.dom.container.textContent).toContain("Loading tags");
  });

  it("distinguishes a failed tag read from an empty tag list and offers retry", async () => {
    const refetch = vi.fn();
    settingsMocks.useTagsQuery.mockReturnValue({ data: undefined, error: new Error("Tag read unavailable"), refetch });
    const harness = await renderSettingsView("/settings?group=tags");
    expect(harness.dom.container.textContent).toContain("Tags could not load");
    expect(harness.dom.container.textContent).toContain("Tag read unavailable");
    expect(harness.dom.container.textContent).not.toContain("Loading tags");
    await harness.act(async () => { getReactProps(buttonWithText(harness.dom.container, "Retry tags"))?.onClick?.(); });
    expect(refetch).toHaveBeenCalledOnce();
  });
});

describe("SettingsView autosave", () => {
  it("saves a change at once without a page Save or Discard", async () => {
    const harness = await renderSettingsView();
    expect(buttonsWithText(harness.dom.container, "Save")).toHaveLength(0);
    expect(buttonsWithText(harness.dom.container, "Discard")).toHaveLength(0);

    const pending = heldPatch();
    await changeSettings(harness);

    expect(settingsMocks.patch).toHaveBeenCalledExactlyOnceWith({ identity: "saved-changed" });
    const status = feedbackWithRole(harness.dom.container, "status");
    expect(getReactProps(status)?.["aria-live"]).toBe("polite");
    expect(status.textContent).toContain("Saving…");

    await harness.act(async () => { pending.resolve(); });
    await waitUntilAct(harness.act, () => feedbackWithRole(harness.dom.container, "status").textContent?.includes("Saved") === true);
    expect(buttonsWithText(harness.dom.container, "Save")).toHaveLength(0);
  });

  it("does not write MCP servers back from the settings it shows", async () => {
    createWriter({ ...savedSettings, mcpServers: { teams: { command: "node", args: ["teams.js"] } } });
    const harness = await renderSettingsView();
    await changeSettings(harness);
    await waitUntilAct(harness.act, () => settingsMocks.patch.mock.calls.length > 0);
    expect(settingsMocks.patch.mock.calls[0][0]).not.toHaveProperty("mcpServers");
  });

  it("undoes the last save from the header", async () => {
    const harness = await renderSettingsView();
    await changeSettings(harness);
    await waitUntilAct(harness.act, () => buttonsWithText(harness.dom.container, "Undo").length === 1, { label: "undo offer" });

    await harness.act(async () => { getReactProps(buttonWithText(harness.dom.container, "Undo"))?.onClick?.(); });
    await waitUntilAct(harness.act, () => settingsMocks.patch.mock.calls.length === 2);
    expect(settingsMocks.patch.mock.calls[1][0]).toEqual({ identity: "saved" });
    expect(server.identity).toBe("saved");
  });

  it("puts a failed change back, announces it, and retries on request", async () => {
    const harness = await renderSettingsView();
    const pending = heldPatch();
    await changeSettings(harness);
    await harness.act(async () => { pending.reject(new Error("offline")); });

    await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "DIV").some((element) => getReactProps(element)?.role === "alert"));
    expect(feedbackWithRole(harness.dom.container, "alert").textContent).toContain("Couldn't save identity: offline");
    expect(writerHost.writer?.getSnapshot().settings?.identity).toBe("saved");

    await harness.act(async () => { getReactProps(buttonWithText(harness.dom.container, "Retry"))?.onClick?.(); });
    await waitUntilAct(harness.act, () => settingsMocks.patch.mock.calls.length === 2);
    expect(settingsMocks.patch.mock.calls[1][0]).toEqual({ identity: "saved-changed" });
  });

  it("offers no retry for a value the server rejected", async () => {
    const harness = await renderSettingsView();
    const pending = heldPatch();
    await changeSettings(harness);
    await harness.act(async () => { pending.reject(new ApiError("identity is too long", 400)); });

    await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "DIV").some((element) => getReactProps(element)?.role === "alert"));
    expect(buttonsWithText(harness.dom.container, "Retry")).toHaveLength(0);
    await harness.act(async () => { getReactProps(buttonWithText(harness.dom.container, "Dismiss"))?.onClick?.(); });
    expect(findAllByTag(harness.dom.container, "DIV").some((element) => getReactProps(element)?.role === "alert")).toBe(false);
  });

  it("shows initial fetch failure with retry instead of an endless loading shell", async () => {
    createWriter(undefined);
    const refetch = vi.fn();
    settingsMocks.useSettingsQuery.mockReturnValue({ data: undefined, isLoading: false, error: new Error("Settings offline"), refetch });
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(MemoryRouter, null, createElement(SettingsView)));
      expect(harness.dom.container.textContent).toContain("Settings could not load");
      expect(harness.dom.container.textContent).toContain("Settings offline");
      await harness.act(async () => { getReactProps(buttonWithText(harness.dom.container, "Retry"))?.onClick?.(); });
      expect(refetch).toHaveBeenCalledOnce();
    } finally { await harness.cleanup(); }
  });
});

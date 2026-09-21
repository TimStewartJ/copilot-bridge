import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AppSettings } from "../api";
import { useSettingsQuery, useSettingsMutation } from "../hooks/queries/useSettings";
import { useTagsQuery } from "../hooks/queries/useTags";
import { AlertTriangle, Settings } from "lucide-react";
import {
  SystemPromptSection,
  ModelSection,
  DeferWorkerSection,
  ComputerUseSection,
  AppearanceSection,
  NotificationsSection,
  DeviceManagementSection,
  ProvidersSection,
  TagsSection,
  SpeechEngineSection,
  UpdatesSection,
  BridgeCommitsSection,
  CopilotUsageSection,
  ManagementJobsSection,
  BrowserDiagnosticsSection,
  SettingsCategoryNav,
} from "./settings";
import { McpServersSection } from "./settings/McpServersSection";
import { SkillsSection } from "./settings/SkillsSection";
import { CopilotQuotaCard } from "./CopilotQuotaMenu";
import {
  DEFAULT_CATEGORY,
  getCategoryMeta,
  SETTINGS_CATEGORIES,
  normalizeCategory,
  type CategoryId,
} from "./settings/settings-layout";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";
import {
  getLastSettingsCategory,
  setLastSettingsCategory,
} from "../lib/settings-routes";
import { DS, cx } from "../design/tokens";
import { Button, Notice } from "../design/primitives";
import { getSettingsDraftUpdates } from "../lib/settings-draft";

type SettingsToast = {
  message: string;
  tone: "success" | "error";
};

function CategoryPanel({
  category,
  activeCategory,
  children,
}: {
  category: CategoryId;
  activeCategory: CategoryId;
  children: React.ReactNode;
}) {
  const isActive = category === activeCategory;
  const [hasBeenActive, setHasBeenActive] = useState(isActive);

  useEffect(() => {
    if (isActive) {
      setHasBeenActive(true);
    }
  }, [isActive]);

  return (
    <div
      role="region"
      aria-label={`${getCategoryMeta(category)?.label ?? category} settings`}
      aria-hidden={!isActive}
      hidden={!isActive}
      className={cx(DS.surface.group, "@container/settings-content min-w-0 divide-y divide-border p-4 sm:p-5 [&>section]:py-5 [&>section:first-child]:pt-0 [&>section:last-child]:pb-0")}
      data-category-panel={category}
    >
      {hasBeenActive ? children : null}
    </div>
  );
}

function SettingsShellSkeleton() {
  return (
    <LoadingSkeletonRegion
      isLoading
      label="Loading settings"
      className="flex-1 flex flex-col min-h-0"
    >
      <div className="flex shrink-0 items-center border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-1.5">
          <Settings size={16} className="text-text-muted" />
          <Skeleton height={18} width={76} shape="pill" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="@container/settings-layout mx-auto w-full max-w-5xl">
          <div className="grid gap-6 @[44rem]/settings-layout:grid-cols-[11rem_minmax(0,1fr)]">
            <div>
              <Skeleton height={40} className="@[44rem]/settings-layout:hidden" />
              <div className="hidden space-y-5 py-3 @[44rem]/settings-layout:block">
                {SETTINGS_CATEGORIES.map((category) => <Skeleton key={category.id} height={14} width="75%" />)}
              </div>
            </div>
            <div className="min-w-0 space-y-5">
              <SkeletonText lines={2} widths={["34%", "70%"]} />
              <div className={cx(DS.surface.group, "space-y-6 p-5")}>
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="space-y-3">
                    <Skeleton height={16} width="32%" />
                    <Skeleton height={40} width="100%" />
                    <SkeletonText lines={1} widths={["68%"]} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

export default function SettingsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: queriedSettings, isLoading: settingsLoading, error: settingsError, refetch: refetchSettings } = useSettingsQuery();
  const settingsMutation = useSettingsMutation();
  const tagsQuery = useTagsQuery();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<SettingsToast | null>(null);
  const [mcpSectionResetSignal, setMcpSectionResetSignal] = useState(0);
  const [rememberedCategory, setRememberedCategory] = useState<CategoryId>(
    getLastSettingsCategory,
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groupParam = searchParams.get("group");
  const activeCategory = groupParam === null
    ? rememberedCategory
    : normalizeCategory(groupParam);
  const categoryMeta = getCategoryMeta(activeCategory);

  const draftUpdates = settings && draft ? getSettingsDraftUpdates(settings, draft) : {};
  const hasChanges = Object.keys(draftUpdates).length > 0;

  // Sync settings from query
  useEffect(() => {
    if (queriedSettings && !settings) {
      setSettings(queriedSettings);
      setDraft(structuredClone(queriedSettings));
    }
  }, [queriedSettings, settings]);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    if (groupParam !== null && groupParam !== activeCategory) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("group", activeCategory);
          return next;
        },
        { replace: true },
      );
    }
  }, [activeCategory, groupParam, setSearchParams]);

  useEffect(() => {
    setLastSettingsCategory(activeCategory);
    if (groupParam !== null) {
      setRememberedCategory(activeCategory);
    }
  }, [activeCategory, groupParam]);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo?.({ top: 0 });
  }, [activeCategory]);

  const setActiveCategory = useCallback(
    (category: CategoryId) => {
      setRememberedCategory(category);
      setLastSettingsCategory(category);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (category === DEFAULT_CATEGORY) {
            next.delete("group");
          } else {
            next.set("group", category);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await settingsMutation.mutateAsync(draftUpdates);
      setSettings(updated);
      setDraft(structuredClone(updated));
      showToast("Settings saved", "success");
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (settings) setDraft(structuredClone(settings));
    setMcpSectionResetSignal((signal) => signal + 1);
  };

  const showToast = (message: string, tone: SettingsToast["tone"]) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = setTimeout(() => { setToast(null); toastTimerRef.current = null; }, 4000);
  };

  if (settingsError && !draft) {
    return (
      <div className={DS.layout.pageColumn}>
        <h1 className={cx(DS.text.pageTitle, "mb-4")}>Settings</h1>
        <Notice tone="danger" icon={<AlertTriangle size={16} />} title="Settings could not load"
          action={<Button size="sm" onClick={() => void refetchSettings()}>Retry</Button>}>
          {settingsError instanceof Error ? settingsError.message : String(settingsError)}
        </Notice>
      </div>
    );
  }

  if (settingsLoading || !draft) return <SettingsShellSkeleton />;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
        <h1 className={cx(DS.text.title, "flex items-center gap-2")}>
          <Settings size={16} className="text-text-muted" />
          Settings
        </h1>
        <CopilotQuotaCard compact className="md:hidden" />
      </div>

      {/* Toast */}
      {toast && (
        <div
          role={toast.tone === "error" ? "alert" : "status"}
          aria-live={toast.tone === "success" ? "polite" : undefined}
          className={cx("mx-6 mt-3 rounded-md border px-4 py-2 text-xs", toast.tone === "error"
              ? cx(DS.notice.surface, "text-error")
              : cx(DS.notice.surface, "text-success"))}
        >
          {toast.message}
        </div>
      )}

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="@container/settings-layout mx-auto w-full max-w-5xl">
        <div className="flex min-w-0 flex-col gap-6 @[44rem]/settings-layout:grid @[44rem]/settings-layout:grid-cols-[11rem_minmax(0,1fr)] @[44rem]/settings-layout:items-start">
          <SettingsCategoryNav
            activeCategory={activeCategory}
            onSelectCategory={setActiveCategory}
            className="min-w-0"
          />

          <div className="min-w-0">
            <header className="mb-5 space-y-1">
              <h2 className={cx(DS.text.title, "hidden @[44rem]/settings-layout:block")}>{categoryMeta?.label}</h2>
              <p className={DS.text.prose}>{categoryMeta?.description}</p>
              {activeCategory === "general" && <p className={DS.field.help}>Defaults use Save. Notification and device controls apply separately.</p>}
              {activeCategory === "integrations" && <p className={DS.field.help}>Provider and computer-use preferences use Save. MCP servers, tags and skills have their own actions.</p>}
            </header>
            {settingsError && (
              <Notice tone="danger" className="mb-4" title="Could not refresh settings"
                action={<Button size="sm" onClick={() => void refetchSettings()}>Retry</Button>}>
                Your current draft is still shown. {settingsError instanceof Error ? settingsError.message : String(settingsError)}
              </Notice>
            )}
            <fieldset disabled={saving} className="min-w-0">
            <CategoryPanel category="general" activeCategory={activeCategory}>
              <ModelSection draft={draft} setDraft={setDraft} />
              <SystemPromptSection draft={draft} setDraft={setDraft} />
              <AppearanceSection draft={draft} setDraft={setDraft} />
              <NotificationsSection />
              <DeviceManagementSection />
              <DeferWorkerSection draft={draft} setDraft={setDraft} />
            </CategoryPanel>

            <CategoryPanel category="integrations" activeCategory={activeCategory}>
              <ProvidersSection draft={draft} setDraft={setDraft} />
              <McpServersSection
                resetSignal={mcpSectionResetSignal}
              />
              <ComputerUseSection draft={draft} setDraft={setDraft} />
              <SkillsSection />
              {tagsQuery.error && (
                <Notice tone="danger" title="Tags could not load"
                  action={<Button size="sm" onClick={() => void tagsQuery.refetch()}>Retry tags</Button>}>
                  {tagsQuery.error instanceof Error ? tagsQuery.error.message : String(tagsQuery.error)}
                  {tagsQuery.data && " The previous tag list is still shown."}
                </Notice>
              )}
              {tagsQuery.data ? <TagsSection tags={tagsQuery.data} />
                : !tagsQuery.error && <p role="status" className={cx(DS.text.prose, "py-4")}>Loading tags…</p>}
            </CategoryPanel>

            <CategoryPanel category="voice" activeCategory={activeCategory}>
              <SpeechEngineSection />
            </CategoryPanel>

            <CategoryPanel category="updates" activeCategory={activeCategory}>
              <UpdatesSection />
              <ManagementJobsSection />
              <BridgeCommitsSection />
            </CategoryPanel>

            <CategoryPanel category="diagnostics" activeCategory={activeCategory}>
              <BrowserDiagnosticsSection draft={draft} setDraft={setDraft} />
            </CategoryPanel>

            <CategoryPanel category="usage" activeCategory={activeCategory}>
              <CopilotUsageSection />
            </CategoryPanel>
            </fieldset>
          </div>
        </div>
        </div>
      </div>

      {/* Sticky unsaved-changes bar */}
      {hasChanges && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-primary px-4 py-3 sm:px-6">
          <span className="text-xs font-medium text-text-secondary">You have unsaved changes</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscard}
              disabled={saving}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary)}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

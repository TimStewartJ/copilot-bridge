import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AppSettings } from "../api";
import { settingsWriter, useSettingsQuery, useSettingsWriter } from "../hooks/queries/useSettings";
import type { SettingsWriterSnapshot } from "../lib/settings-writer";
import { useTagsQuery } from "../hooks/queries/useTags";
import { AlertTriangle, Check, Loader2, RotateCw, Settings } from "lucide-react";
import {
  SystemPromptSection,
  ModelSection,
  DeferWorkerSection,
  SubagentModelsSection,
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
  BridgeRuntimeSection,
  SettingsCategoryNav,
} from "./settings";
import { McpServersSection } from "./settings/McpServersSection";
import { SkillsSection } from "./settings/SkillsSection";
import { CopilotQuotaCard } from "./CopilotQuotaMenu";
import {
  DEFAULT_CATEGORY,
  getCategoryMeta,
  legacySectionFor,
  normalizeCategory,
  normalizeSystemSection,
  SETTINGS_CATEGORIES,
  type CategoryId,
} from "./settings/settings-layout";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";
import {
  getLastSettingsCategory,
  setLastSettingsCategory,
} from "../lib/settings-routes";
import { DS, cx } from "../design/tokens";
import { Button, Notice } from "../design/primitives";
import { applySettingsChanges } from "../lib/settings-draft";

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

/** How long "Saved · Undo" stays in the header after a save. */
const SAVED_NOTICE_MS = 6_000;

/**
 * Settings save as they change; this says what happened to the last change. A failure stays until
 * it is retried, dismissed, or the setting is changed again.
 */
function SaveStatus({ state }: { state: SettingsWriterSnapshot }) {
  const { status, error } = state;
  const savedAt = status.kind === "saved" ? status.at : null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (savedAt === null) return;
    const remaining = SAVED_NOTICE_MS - (Date.now() - savedAt);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), remaining);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const showSaved = status.kind === "saved" && Date.now() - status.at < SAVED_NOTICE_MS;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs">
      {error && (
        <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-2 text-error">
          <span className="min-w-0 break-words">{error.message}</span>
          {error.retryable && <Button size="sm" variant="ghost" onClick={() => settingsWriter.retry()}>Retry</Button>}
          <Button size="sm" variant="ghost" onClick={() => settingsWriter.dismissError()}>Dismiss</Button>
        </div>
      )}
      <div role="status" aria-live="polite" className="flex items-center gap-1 text-text-secondary">
        {status.kind === "saving" && <><Loader2 size={12} className="animate-spin" aria-hidden="true" />Saving…</>}
        {showSaved && !error && (
          <>
            <Check size={12} aria-hidden="true" />
            Saved
            {status.kind === "saved" && status.canUndo && (
              <Button size="sm" variant="ghost" onClick={() => settingsWriter.undo()}>Undo</Button>
            )}
          </>
        )}
      </div>
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
  const { isLoading: settingsLoading, error: settingsError, refetch: refetchSettings } = useSettingsQuery();
  const writerState = useSettingsWriter();
  const draft = writerState.settings;
  const tagsQuery = useTagsQuery();
  const [systemRefresh, setSystemRefresh] = useState(0);
  const [rememberedCategory, setRememberedCategory] = useState<CategoryId>(
    getLastSettingsCategory,
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const groupParam = searchParams.get("group");
  const legacySection = legacySectionFor(groupParam);
  const sectionParam = normalizeSystemSection(searchParams.get("section")) ?? legacySection;
  const activeCategory = groupParam === null
    ? rememberedCategory
    : normalizeCategory(groupParam);
  const categoryMeta = getCategoryMeta(activeCategory);

  // Sections build a whole settings object from the one they were rendered with; only what they
  // changed is applied to the latest settings, which the writer then saves.
  const setDraft = useCallback((next: AppSettings) => {
    if (!draft) return;
    const base = draft;
    settingsWriter.update((current) => applySettingsChanges(base, next, current));
  }, [draft]);

  useEffect(() => {
    if (groupParam !== null && groupParam !== activeCategory) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("group", activeCategory);
          // A retired category link keeps pointing at the same content on the System page.
          if (legacySection && !next.has("section")) next.set("section", legacySection);
          return next;
        },
        { replace: true },
      );
    }
  }, [activeCategory, groupParam, legacySection, setSearchParams]);

  useEffect(() => {
    setLastSettingsCategory(activeCategory);
    if (groupParam !== null) {
      setRememberedCategory(activeCategory);
    }
  }, [activeCategory, groupParam]);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo?.({ top: 0 });
  }, [activeCategory]);

  const hasSettings = draft !== null;
  useEffect(() => {
    if (activeCategory !== "system" || !sectionParam || !hasSettings) return;
    // After the panel has rendered its sections.
    const timer = setTimeout(() => {
      scrollContainerRef.current?.querySelector?.(`#settings-system-${sectionParam}`)?.scrollIntoView?.({ block: "start" });
    }, 0);
    return () => clearTimeout(timer);
  }, [activeCategory, hasSettings, sectionParam]);

  // A change that has not reached the server yet would be lost with the page.
  const unsaved = writerState.pendingKeys.size > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const setActiveCategory = useCallback(
    (category: CategoryId) => {
      setRememberedCategory(category);
      setLastSettingsCategory(category);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("section");
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
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
        <h1 className={cx(DS.text.title, "flex shrink-0 items-center gap-2")}>
          <Settings size={16} className="text-text-muted" />
          Settings
        </h1>
        <div className="flex min-w-0 items-center gap-2">
          <SaveStatus state={writerState} />
          <CopilotQuotaCard compact className="md:hidden" />
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="@container/settings-layout mx-auto w-full max-w-5xl">
        <div className="flex min-w-0 flex-col gap-6 @[44rem]/settings-layout:grid @[44rem]/settings-layout:grid-cols-[11rem_minmax(0,1fr)] @[44rem]/settings-layout:items-start">
          <SettingsCategoryNav
            activeCategory={activeCategory}
            onSelectCategory={setActiveCategory}
            className="min-w-0"
          />

          <div className="min-w-0">
            <header className={cx("mb-4 min-h-8 items-center justify-between gap-2", activeCategory === "system" ? "flex" : "hidden @[44rem]/settings-layout:flex")}>
              <h2 className={cx(DS.text.title, "hidden @[44rem]/settings-layout:block")}>{categoryMeta?.label}</h2>
              {activeCategory === "system" && (
                <Button size="sm" variant="ghost" className="ml-auto" icon={<RotateCw size={13} />}
                  onClick={() => setSystemRefresh((signal) => signal + 1)}>
                  Refresh
                </Button>
              )}
            </header>
            {settingsError && (
              <Notice tone="danger" className="mb-4" title="Could not refresh settings"
                action={<Button size="sm" onClick={() => void refetchSettings()}>Retry</Button>}>
                The settings shown may be out of date. {settingsError instanceof Error ? settingsError.message : String(settingsError)}
              </Notice>
            )}
            <CategoryPanel category="chat" activeCategory={activeCategory}>
              <ModelSection draft={draft} setDraft={setDraft} />
              <DeferWorkerSection draft={draft} setDraft={setDraft} />
              <SubagentModelsSection draft={draft} setDraft={setDraft} />
            </CategoryPanel>

            <CategoryPanel category="responses" activeCategory={activeCategory}>
              <SystemPromptSection draft={draft} setDraft={setDraft} />
            </CategoryPanel>

            <CategoryPanel category="appearance" activeCategory={activeCategory}>
              <AppearanceSection draft={draft} setDraft={setDraft} />
            </CategoryPanel>

            <CategoryPanel category="device" activeCategory={activeCategory}>
              <NotificationsSection />
              <DeviceManagementSection />
            </CategoryPanel>

            <CategoryPanel category="integrations" activeCategory={activeCategory}>
              <ProvidersSection draft={draft} setDraft={setDraft} />
              <McpServersSection />
              <ComputerUseSection draft={draft} setDraft={setDraft} />
              <SkillsSection />
            </CategoryPanel>

            <CategoryPanel category="tags" activeCategory={activeCategory}>
              {tagsQuery.error && (
                <Notice tone="danger" title="Tags could not load"
                  action={<Button size="sm" onClick={() => void tagsQuery.refetch()}>Retry tags</Button>}>
                  {tagsQuery.error instanceof Error ? tagsQuery.error.message : String(tagsQuery.error)}
                  {tagsQuery.data && " The previous tag list is still shown."}
                </Notice>
              )}
              {tagsQuery.data ? <TagsSection tags={tagsQuery.data} />
                : !tagsQuery.error && <p role="status" className={DS.field.help}>Loading tags…</p>}
            </CategoryPanel>

            <CategoryPanel category="voice" activeCategory={activeCategory}>
              <SpeechEngineSection />
            </CategoryPanel>

            <CategoryPanel category="system" activeCategory={activeCategory}>
              <BridgeRuntimeSection refreshSignal={systemRefresh} />
              <UpdatesSection refreshSignal={systemRefresh} />
              <ManagementJobsSection refreshSignal={systemRefresh} open={sectionParam === "jobs"} />
              <BrowserDiagnosticsSection draft={draft} setDraft={setDraft} refreshSignal={systemRefresh} open={sectionParam === "browser"} />
              <BridgeCommitsSection refreshSignal={systemRefresh} open={sectionParam === "version"} />
            </CategoryPanel>

            <CategoryPanel category="usage" activeCategory={activeCategory}>
              <CopilotUsageSection />
            </CategoryPanel>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

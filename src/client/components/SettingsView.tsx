import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AppSettings, Tag } from "../api";
import { useSettingsQuery, useSettingsMutation } from "../hooks/queries/useSettings";
import { useTagsQuery } from "../hooks/queries/useTags";
import { Settings } from "lucide-react";
import {
  SystemPromptSection,
  ModelSection,
  ReasoningEffortSection,
  AppearanceSection,
  ProvidersSection,
  TagsSection,
  VoiceInputSection,
  BridgeCommitsSection,
  CopilotUsageSection,
  SettingsCategoryNav,
} from "./settings";
import { McpServersSection } from "./settings/McpServersSection";
import {
  DEFAULT_CATEGORY,
  SETTINGS_CATEGORIES,
  normalizeCategory,
  type CategoryId,
} from "./settings/settings-layout";
import { LoadingSkeletonRegion, Skeleton, SkeletonCard, SkeletonText } from "./shared/Skeleton";

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
      role="tabpanel"
      aria-hidden={!isActive}
      hidden={!isActive}
      className="space-y-6"
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
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-1.5">
          <Settings size={16} className="text-text-muted" />
          <Skeleton height={18} width={76} shape="pill" />
        </div>
        <Skeleton height={30} width={64} shape="rounded" />
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:items-start">
          <div className="min-w-0">
            <div className="md:hidden">
              <div className="-mx-1 overflow-x-auto pb-1">
                <div className="inline-flex min-w-full gap-1 rounded-xl border border-border bg-bg-elevated p-1">
                  {SETTINGS_CATEGORIES.map((category, index) => (
                    <Skeleton
                      key={category.id}
                      height={36}
                      width={`${34 - index * 4}%`}
                      className="flex-1"
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="hidden rounded-xl border border-border bg-bg-elevated p-2 md:block">
              <Skeleton height={10} width={74} shape="pill" className="mx-2 mb-3" />
              <div className="space-y-1">
                {SETTINGS_CATEGORIES.map((category, index) => (
                  <div key={category.id} className="rounded-lg px-3 py-2.5">
                    <SkeletonText
                      lines={2}
                      widths={index === 0 ? ["58%", "40%"] : ["68%", "34%"]}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-6">
            {Array.from({ length: 4 }, (_, index) => (
              <SkeletonCard key={index} className="space-y-4">
                <div className="space-y-2">
                  <Skeleton height={18} width={index === 0 ? "34%" : "28%"} shape="pill" />
                  <SkeletonText lines={2} widths={["82%", "58%"]} />
                </div>
                <div className="rounded-md border border-border bg-bg-elevated p-4">
                  <Skeleton height={34} className="w-full" />
                  {index < 2 && (
                    <SkeletonText
                      lines={2}
                      widths={["44%", "66%"]}
                      className="mt-3"
                      lineClassName="h-2.5"
                    />
                  )}
                </div>
              </SkeletonCard>
            ))}
          </div>
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

export default function SettingsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: queriedSettings, isLoading: settingsLoading } = useSettingsQuery();
  const settingsMutation = useSettingsMutation();
  const { data: queriedTags = [] } = useTagsQuery();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mcpSectionResetSignal, setMcpSectionResetSignal] = useState(0);
  const [tags, setTags] = useState<Tag[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const groupParam = searchParams.get("group");
  const activeCategory = normalizeCategory(groupParam);

  const hasChanges =
    settings && draft && JSON.stringify(settings) !== JSON.stringify(draft);

  // Sync settings from query
  useEffect(() => {
    if (queriedSettings && !settings) {
      setSettings(queriedSettings);
      setDraft(structuredClone(queriedSettings));
      setLoading(false);
    }
  }, [queriedSettings, settings]);

  // Sync tags from query
  useEffect(() => {
    setTags(queriedTags);
  }, [queriedTags]);

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
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [activeCategory]);

  const setActiveCategory = useCallback(
    (category: CategoryId) => {
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
      const updated = await settingsMutation.mutateAsync(draft);
      setSettings(updated);
      setDraft(structuredClone(updated));
      showToast("Settings saved — changes apply on next session interaction");
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (settings) setDraft(structuredClone(settings));
    setMcpSectionResetSignal((signal) => signal + 1);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  if ((loading || settingsLoading) && !draft) return <SettingsShellSkeleton />;

  if (!draft) {
    return (
      <div className="flex-1 flex items-center justify-center text-error">
        Failed to load settings
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border bg-bg-secondary">
        <h1 className="text-lg font-medium text-text-primary flex items-center gap-1.5">
          <Settings size={16} className="text-text-muted" />
          Settings
        </h1>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Discard
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
              hasChanges
                ? "bg-accent text-white hover:bg-accent-hover"
                : "bg-bg-elevated text-text-faint cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="mx-6 mt-3 px-4 py-2 bg-accent/15 text-accent text-xs rounded-md border border-accent/20">
          {toast}
        </div>
      )}

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:items-start">
          <SettingsCategoryNav
            activeCategory={activeCategory}
            onSelectCategory={setActiveCategory}
            className="min-w-0"
          />

          <div className="min-w-0">
            <CategoryPanel category="general" activeCategory={activeCategory}>
              <SystemPromptSection draft={draft} setDraft={setDraft} />
              <ModelSection draft={draft} setDraft={setDraft} />
              <ReasoningEffortSection draft={draft} setDraft={setDraft} />
              <AppearanceSection draft={draft} setDraft={setDraft} />
            </CategoryPanel>

            <CategoryPanel category="integrations" activeCategory={activeCategory}>
              <ProvidersSection draft={draft} setDraft={setDraft} />
              <TagsSection tags={tags} setTags={setTags} />
              <McpServersSection
                draft={draft}
                onDraftChange={setDraft}
                resetSignal={mcpSectionResetSignal}
              />
            </CategoryPanel>

            <CategoryPanel category="diagnostics" activeCategory={activeCategory}>
              <BridgeCommitsSection />
              <CopilotUsageSection />
              <VoiceInputSection />
            </CategoryPanel>
          </div>
        </div>
      </div>

      {/* Sticky unsaved-changes bar */}
      {hasChanges && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-3 border-t border-accent/30 bg-accent/10 backdrop-blur">
          <span className="text-xs text-accent font-medium">You have unsaved changes</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

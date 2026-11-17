// Settings › Usage › Chat grades: grade picked chats with Copilot's classifiers, compare per model.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchChatGrades, startChatGrading } from "../../api";
import { queryKeys } from "../../queryClient";
import { copilotUsageDayKey } from "../../../shared/copilot-usage-range";
import type { ChatGradesClassifier, ChatGradesFilters } from "../../../shared/chat-grades.js";
import { Button, ChoiceButton, EmptyHint, IconButton, MetaLine, Section, Select, Switch, TextInput } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";
import { formatUsageCount, formatUsageNumber } from "../../lib/usage-presentation";
import { finalizeVegaEmbed, renderVegaLite, type VegaEmbedResult } from "../VegaLiteVisual";
import { buildChatGradesChartSpec, readChartColors, type ChartSegment } from "./chat-grades-chart";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_RANGE_DAYS = 28;
const DEFAULT_CLASSIFIER = "task_outcome";

/** Names for the classifiers the runtime ships today; any other is shown by its own name. */
const CLASSIFIER_NAMES: Readonly<Record<string, string>> = {
  task_outcome: "Task outcome",
  user_message_sentiment: "Sentiment",
  session_taxonomy: "Kind of work",
  requested_task_demand: "Request size",
};

export function classifierName(classifier: string): string {
  return CLASSIFIER_NAMES[classifier] ?? classifier;
}

// Classifiers about a chat's structure, not how it went; task_taxonomy repeats session_taxonomy.
const HIDDEN_CLASSIFIERS: ReadonlySet<string> = new Set(["turn_splitting", "prompt_language", "task_taxonomy"]);

function defaultRange(now = new Date()): { from: string; to: string } {
  const start = new Date(now);
  start.setDate(start.getDate() - (DEFAULT_RANGE_DAYS - 1));
  return { from: copilotUsageDayKey(start) ?? "", to: copilotUsageDayKey(now) ?? "" };
}

/** The `data-theme` the app has applied, so the chart can redraw in the other theme's colours. */
function useDocumentTheme(): string | null {
  const read = () => (typeof document === "undefined" ? null : document.documentElement?.getAttribute?.("data-theme") ?? null);
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function ChatGradesSection() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState(defaultRange);
  const [models, setModels] = useState<string[]>([]);
  const [includeScheduled, setIncludeScheduled] = useState(false);
  const [classifierChoice, setClassifierChoice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChartSegment | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters: ChatGradesFilters = useMemo(() => ({
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(models.length > 0 ? { models } : {}),
    includeScheduled,
  }), [range, models, includeScheduled]);

  const { data, error: loadError, isLoading } = useQuery({
    queryKey: queryKeys.chatGrades(filters),
    queryFn: ({ signal }) => fetchChatGrades(filters, signal),
    refetchInterval: (query) => (query.state.data?.run.running ? POLL_INTERVAL_MS : false),
    placeholderData: (previous) => previous,
  });

  useEffect(() => { setSelected(null); }, [filters, classifierChoice]);

  const names = useMemo(() => new Map((data?.models ?? []).map((model) => [model.id, model.name])), [data?.models]);
  const modelName = (id: string) => names.get(id) ?? id;
  const classifiers = (data?.report.classifiers ?? []).filter((entry) => !HIDDEN_CLASSIFIERS.has(entry.classifier));
  const classifier: ChatGradesClassifier | undefined = classifiers.find((entry) => entry.classifier === classifierChoice)
    ?? classifiers.find((entry) => entry.classifier === DEFAULT_CLASSIFIER)
    ?? classifiers[0];

  const toggleModel = (id: string) => setModels((current) => (current.includes(id) ? current.filter((model) => model !== id) : [...current, id]));
  const regrade = Boolean(data && data.ungraded === 0);
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await startChatGrading(filters, regrade);
      await queryClient.invalidateQueries({ queryKey: ["chat-grades"] });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  };

  const selectedChats = selected && classifier
    ? (data?.report.chats ?? []).filter((chat) => chat.model === selected.model && chat.labels[classifier.classifier]?.includes(selected.value))
    : [];

  return (
    <Section level="page" label="Chat grades">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <TextInput type="date" inputSize="sm" aria-label="From date" className="w-40" value={range.from} max={range.to || undefined}
              onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} />
            <span className={DS.text.meta} aria-hidden="true">–</span>
            <TextInput type="date" inputSize="sm" aria-label="To date" className="w-40" value={range.to} min={range.from || undefined}
              onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} />
          </div>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Switch checked={includeScheduled} onChange={(event) => setIncludeScheduled(event.target.checked)} />
            Include scheduled runs
          </label>
        </div>

        {(data?.models.length ?? 0) > 0 && (
          <div className={DS.choice.group} role="group" aria-label="Models">
            {data!.models.map((model) => (
              <ChoiceButton key={model.id} selected={models.includes(model.id)} onClick={() => toggleModel(model.id)}>
                {model.name} <span className={DS.text.meta}>{model.chats}</span>
              </ChoiceButton>
            ))}
          </div>
        )}

        {isLoading && !data && <p className={cx(DS.text.meta, DS.motion.live)}>Finding chats…</p>}
        {!data && loadError && <p role="alert" className="text-xs text-error">{loadError instanceof Error ? loadError.message : String(loadError)}</p>}

        {data && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <MetaLine items={[
                `${formatUsageNumber(data.matching)} ${data.matching === 1 ? "chat matches" : "chats match"}`,
                `${data.graded} graded`,
                data.skipped > 0 && `${data.skipped} skipped`,
              ]} />
              {data.run.running
                ? <span className={cx(DS.text.meta, DS.motion.live)}>Grading {data.run.done} of {data.run.total}</span>
                : data.matching > 0 && (
                  <Button size="sm" disabled={starting} onClick={() => { void start(); }}>
                    {regrade ? "Grade again" : `Grade ${formatUsageCount(data.ungraded, "chat")}`}
                  </Button>
                )}
            </div>
            {data.matching > 0 && <p className={DS.usage.meta}>Copilot's judge models grade each chat, using AI credits.</p>}
            {error && <p role="alert" className="text-xs text-error">{error}</p>}

            {data.matching === 0
              ? <EmptyHint>No chats match.</EmptyHint>
              : !classifier
                ? <EmptyHint>Nothing graded yet.</EmptyHint>
                : (
                  <div className="space-y-2">
                    <Select inputSize="sm" aria-label="Classifier" className="w-auto" value={classifier.classifier}
                      onChange={(event) => setClassifierChoice(event.target.value)}>
                      {classifiers.map((entry) => (
                        <option key={entry.classifier} value={entry.classifier}>{classifierName(entry.classifier)}</option>
                      ))}
                    </Select>
                    <ChatGradesChart
                      classifier={classifier}
                      modelName={modelName}
                      selected={selected}
                      onSegment={(segment) => setSelected((current) => (
                        current && segment && current.model === segment.model && current.value === segment.value ? null : segment
                      ))}
                    />
                    {selected && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className={DS.text.sectionLabel}>{modelName(selected.model)} · {selected.value}</span>
                          <IconButton label="Clear selection" onClick={() => setSelected(null)}><X size={12} /></IconButton>
                        </div>
                        <ul className={DS.surface.divided}>
                          {selectedChats.map((chat) => (
                            <li key={chat.sessionId}>
                              <Link to={`/sessions/${chat.sessionId}`} className={cx(DS.row.base, DS.row.interactive)}>
                                <span className={cx(DS.row.detail, "text-text-primary")}>{chat.title || "Untitled chat"}</span>
                                <span className={DS.row.trailing}>{modelName(chat.model)}{chat.date ? ` · ${chat.date}` : ""}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
          </>
        )}
      </div>
    </Section>
  );
}

interface ChatGradesChartProps {
  classifier: ChatGradesClassifier;
  modelName: (model: string) => string;
  selected: ChartSegment | null;
  onSegment: (segment: ChartSegment | null) => void;
}

/** Draws the chart with vega-embed in theme colours and reports the segment a click lands on. */
function ChatGradesChart({ classifier, modelName, selected, onSegment }: ChatGradesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const theme = useDocumentTheme();
  const [renderError, setRenderError] = useState<string | null>(null);
  // The theme attribute changes what the colour variables hold.
  const colors = useMemo(() => readChartColors(), [theme]);
  const specJson = JSON.stringify(buildChatGradesChartSpec(classifier, modelName, colors, selected));

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let cancelled = false;
    let result: VegaEmbedResult | null = null;
    setRenderError(null);
    renderVegaLite(element, JSON.parse(specJson) as Record<string, unknown>, { tooltipTheme: theme === "light" ? "light" : "dark" }).then(
      (embedded) => {
        if (cancelled) {
          finalizeVegaEmbed(embedded);
          return;
        }
        result = embedded;
        embedded.view?.addEventListener?.("click", (_event, item) => {
          const datum = item?.datum as { model?: unknown; value?: unknown } | undefined;
          onSegmentRef.current(typeof datum?.model === "string" && typeof datum.value === "string"
            ? { model: datum.model, value: datum.value }
            : null);
        });
      },
      (error) => { if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error)); },
    );
    return () => {
      cancelled = true;
      finalizeVegaEmbed(result);
      element.innerHTML = "";
    };
  }, [specJson, theme]);

  return (
    <div className="min-w-0">
      {renderError && <p role="alert" className="text-xs text-error">{renderError}</p>}
      <div ref={containerRef} className="w-full min-w-0" />
    </div>
  );
}

// The Chat grades chart: one horizontal bar per model, split by the share of each label value the
// selected classifier gave. Values are open strings from the Copilot runtime, coloured by rank.
import type { ChatGradesClassifier } from "../../../shared/chat-grades.js";
import { formatUsageCount } from "../../lib/usage-presentation";

export interface ChartColors {
  /** Categorical colours for label values, in rank order. */
  palette: string[];
  text: string;
  grid: string;
}

export interface ChartSegment {
  model: string;
  value: string;
}

// The identity swatches: distinct hues tuned for contrast in each theme (index.css).
const PALETTE_VARIABLES = [
  "--color-identity-blue",
  "--color-identity-amber",
  "--color-identity-emerald",
  "--color-identity-rose",
  "--color-identity-purple",
  "--color-identity-cyan",
  "--color-identity-orange",
  "--color-identity-pink",
  "--color-identity-indigo",
  "--color-identity-slate",
] as const;

const FALLBACK_COLORS: ChartColors = {
  palette: ["#59a0f9", "#e3ae28", "#3db87c", "#ee6570", "#b883e6", "#17bac8", "#ea7d2e", "#f080b8", "#8189ef", "#94a0ae"],
  text: "#cacaca",
  grid: "#2c2c2c",
};

/** The current theme's colours, read from its CSS variables; canvas rendering cannot resolve var(). */
export function readChartColors(): ChartColors {
  if (typeof document === "undefined" || !document.documentElement || typeof getComputedStyle !== "function") return FALLBACK_COLORS;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    palette: PALETTE_VARIABLES.map((name, index) => read(name, FALLBACK_COLORS.palette[index]!)),
    text: read("--color-text-secondary", FALLBACK_COLORS.text),
    grid: read("--color-border-subtle", FALLBACK_COLORS.grid),
  };
}

const UNIT_NOUNS: Readonly<Record<string, string>> = { session: "chat", task: "task", turn: "turn", prompt: "message" };

/** What one of the classifier's counts is: a chat, task, turn or message. */
export function unitNoun(scope: string): string {
  return UNIT_NOUNS[scope] ?? "unit";
}

export interface ChartRow {
  model: string;
  modelName: string;
  bar: string;
  value: string;
  count: number;
  percent: number;
  rank: number;
  dim: boolean;
}

/** One row per bar segment; values ranked by their total count across models. */
export function buildChartRows(
  classifier: ChatGradesClassifier,
  modelName: (model: string) => string,
  selected?: ChartSegment | null,
): { rows: ChartRow[]; values: string[] } {
  const totals = new Map<string, number>();
  for (const series of classifier.models) {
    for (const entry of series.values) totals.set(entry.value, (totals.get(entry.value) ?? 0) + entry.count);
  }
  const values = [...totals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
  const noun = unitNoun(classifier.scope);
  const rows = [...classifier.models]
    .sort((left, right) => modelName(left.model).localeCompare(modelName(right.model)))
    .flatMap((series) => {
      const bar = `${modelName(series.model)} · ${formatUsageCount(series.units, noun)}`;
      return series.values.map((entry) => ({
        model: series.model,
        modelName: modelName(series.model),
        bar,
        value: entry.value,
        count: entry.count,
        percent: series.units > 0 ? entry.count / series.units : 0,
        rank: values.indexOf(entry.value),
        dim: Boolean(selected) && !(selected!.model === series.model && selected!.value === entry.value),
      }));
    });
  return { rows, values };
}

/** A Vega-Lite spec: horizontal 100% stacked bars, one per model, with each bar's unit count in its label. */
export function buildChatGradesChartSpec(
  classifier: ChatGradesClassifier,
  modelName: (model: string) => string,
  colors: ChartColors,
  selected?: ChartSegment | null,
): Record<string, unknown> {
  const { rows, values } = buildChartRows(classifier, modelName, selected);
  const bars = [...new Set(rows.map((row) => row.bar))];
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: rows },
    width: "container",
    height: { step: 30 },
    background: "transparent",
    mark: { type: "bar", cursor: "pointer" },
    encoding: {
      y: { field: "bar", type: "nominal", sort: bars, title: null, axis: { labelLimit: 220 } },
      x: { field: "count", type: "quantitative", stack: "normalize", title: null, axis: { format: "%", tickCount: 4 } },
      color: {
        field: "value",
        type: "nominal",
        title: null,
        scale: { domain: values, range: values.map((_, index) => colors.palette[index % colors.palette.length]) },
        legend: { orient: "bottom", columns: 3, symbolType: "square", labelLimit: 200 },
      },
      order: { field: "rank", type: "quantitative" },
      opacity: { condition: { test: "datum.dim", value: 0.3 }, value: 1 },
      tooltip: [
        { field: "modelName", type: "nominal", title: "Model" },
        { field: "value", type: "nominal", title: "Value" },
        { field: "count", type: "quantitative", title: "Count" },
        { field: "percent", type: "quantitative", title: "Percent", format: ".0%" },
      ],
    },
    config: {
      view: { stroke: null },
      axis: { labelColor: colors.text, domainColor: colors.grid, tickColor: colors.grid, gridColor: colors.grid, labelFontSize: 11 },
      legend: { labelColor: colors.text, labelFontSize: 11 },
    },
  };
}

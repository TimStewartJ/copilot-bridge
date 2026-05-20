#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const summaryPath = process.argv[2] ?? "coverage/coverage-summary.json";
const metricNames = ["statements", "branches", "functions", "lines"];

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "n/a";
}

function count(metric) {
  if (!metric || typeof metric !== "object") return "n/a";
  return `${metric.covered ?? 0}/${metric.total ?? 0}`;
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function metricCells(entry) {
  return metricNames.flatMap((name) => [pct(entry?.[name]?.pct), count(entry?.[name])]);
}

function tableRow(cells) {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

export function buildCoverageMarkdown(summary) {
  const total = summary.total;
  const files = Object.entries(summary)
    .filter(([name]) => name !== "total")
    .sort(([a], [b]) => a.localeCompare(b));

  const lines = [
    "## Coverage",
    "",
    tableRow(["Metric", "Percent", "Covered"]),
    tableRow(["---", "---:", "---:"]),
    ...metricNames.map((name) => tableRow([name, pct(total?.[name]?.pct), count(total?.[name])])),
    "",
    `<details open><summary>File coverage breakdown (${files.length} files)</summary>`,
    "",
    tableRow(["File", "Statements", "Covered", "Branches", "Covered", "Functions", "Covered", "Lines", "Covered"]),
    tableRow(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]),
    ...files.map(([file, entry]) => tableRow([file, ...metricCells(entry)])),
    "",
    "</details>",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function writeSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }
  process.stdout.write(markdown);
}

if (!existsSync(summaryPath)) {
  writeSummary(`## Coverage\n\nCoverage summary was not generated at \`${summaryPath}\`.\n`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
writeSummary(buildCoverageMarkdown(summary));


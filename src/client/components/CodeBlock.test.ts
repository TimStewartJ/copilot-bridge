import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CodeBlock from "./CodeBlock";

function renderCodeBlock(text: string, language?: string): string {
  return renderToStaticMarkup(createElement(CodeBlock, null, createElement("code", {
    className: language ? `language-${language}` : undefined,
  }, text)));
}

describe("CodeBlock diff rendering", () => {
  const unifiedDiff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,3 +1,3 @@",
    " const kept = true;",
    "-const oldValue = true;",
    "+const newValue = true;",
  ].join("\n");

  it("styles unified diff rows for explicit diff fences", () => {
    const html = renderCodeBlock(unifiedDiff, "diff");

    expect(html).toContain("bg-bg-secondary text-text-muted");
    expect(html).toContain("bg-accent-surface text-accent");
    expect(html).toContain("bg-error/10 text-error");
    expect(html).toContain("bg-success/10 text-success");
    expect(html).toContain("-const oldValue = true;");
    expect(html).toContain("+const newValue = true;");
  });

  it("supports patch and udiff language aliases", () => {
    expect(renderCodeBlock(unifiedDiff, "patch")).toContain("bg-success/10 text-success");
    expect(renderCodeBlock(unifiedDiff, "udiff")).toContain("bg-error/10 text-error");
  });

  it("auto-detects unlabeled unified diffs with hunks", () => {
    const html = renderCodeBlock([
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n"));

    expect(html).toContain("bg-accent-surface text-accent");
    expect(html).toContain("bg-error/10 text-error");
    expect(html).toContain("bg-success/10 text-success");
  });

  it("keeps non-diff code blocks on the normal code path", () => {
    const html = renderCodeBlock("const value = oldValue + newValue;", "ts");

    expect(html).toContain("language-ts");
    expect(html).not.toContain("bg-success/10 text-success");
    expect(html).not.toContain("bg-error/10 text-error");
  });
});

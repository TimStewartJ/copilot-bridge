import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import CodeBlock from "./CodeBlock";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
} from "../test-react-harness";

function renderCodeBlock(text: string, language?: string): string {
  return renderToStaticMarkup(createElement(CodeBlock, null, createElement("code", {
    className: language ? `language-${language}` : undefined,
  }, text)));
}

function findCopyButton(root: any): any {
  const button = findAllByTag(root, "BUTTON")[0];
  if (!button) throw new Error("Copy button not found");
  return button;
}

function copyButtonLabel(root: any): string {
  const button = findCopyButton(root);
  return getReactProps(button)?.["aria-label"] ?? button.getAttribute?.("aria-label") ?? "";
}

function clickCopyButton(root: any) {
  getReactProps(findCopyButton(root))?.onClick?.({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
}

function setClipboard(clipboard: unknown) {
  (globalThis.navigator as unknown as { clipboard?: unknown }).clipboard = clipboard;
}

type FallbackDocument = {
  createElement: (tag: string) => { tagName: string; value?: string; select?: () => void };
  execCommand?: (command: string) => boolean;
};

function installExecCommandFallback(): { execCommands: string[]; copiedValues: (string | undefined)[]; restore: () => void } {
  const shimDocument = globalThis.document as unknown as FallbackDocument;
  const originalCreateElement = shimDocument.createElement;
  const execCommands: string[] = [];
  const copiedValues: (string | undefined)[] = [];
  let lastTextArea: { value?: string } | null = null;

  shimDocument.createElement = (tag: string) => {
    const element = originalCreateElement.call(shimDocument, tag);
    if (element.tagName === "TEXTAREA") {
      element.select = () => { lastTextArea = element; };
    }
    return element;
  };
  shimDocument.execCommand = (command: string) => {
    execCommands.push(command);
    copiedValues.push(lastTextArea?.value);
    return true;
  };

  return {
    execCommands,
    copiedValues,
    restore() {
      shimDocument.createElement = originalCreateElement;
      delete shimDocument.execCommand;
    },
  };
}

describe("CodeBlock copy button", () => {
  const unhandledRejections: unknown[] = [];
  const recordUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };

  afterEach(() => {
    process.off("unhandledRejection", recordUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("surfaces a failure instead of a copied confirmation when the clipboard write rejects", async () => {
    process.on("unhandledRejection", recordUnhandledRejection);
    const harness = await createReactDomHarness();
    try {
      const writeText = vi.fn().mockRejectedValue(new Error("Clipboard permission denied"));
      setClipboard({ writeText });

      await harness.render(createElement(CodeBlock, null, createElement("code", null, "const value = 1;")));
      await harness.act(async () => { clickCopyButton(harness.dom.container); });
      await waitUntilAct(harness.act, () => copyButtonLabel(harness.dom.container) === "Copy failed", {
        label: "copy failure state",
      });

      // Give Node a full macrotask turn so an unhandled rejection would surface.
      await harness.act(async () => {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      });

      expect(copyButtonLabel(harness.dom.container)).toBe("Copy failed");
      expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => copyButtonLabel(button)))
        .not.toContain("Copied");
      expect(unhandledRejections).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("copies through the textarea fallback when the clipboard API is unavailable", async () => {
    const harness = await createReactDomHarness();
    const fallback = installExecCommandFallback();
    try {
      setClipboard(undefined);

      await harness.render(createElement(CodeBlock, null, createElement("code", null, "fallback snippet")));
      await harness.act(async () => { clickCopyButton(harness.dom.container); });
      await waitUntilAct(harness.act, () => copyButtonLabel(harness.dom.container) === "Copied", {
        label: "fallback copy confirmation",
      });

      expect(fallback.execCommands).toEqual(["copy"]);
      expect(fallback.copiedValues).toEqual(["fallback snippet"]);
    } finally {
      fallback.restore();
      await harness.cleanup();
    }
  });
});

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

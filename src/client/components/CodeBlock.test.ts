import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";

const clipboardMocks = vi.hoisted(() => ({ writeClipboardText: vi.fn() }));

vi.mock("../lib/clipboard", () => ({
  writeClipboardText: clipboardMocks.writeClipboardText,
}));

async function renderMarkdown(markdown: string) {
  const harness = await createReactDomHarness();
  const [{ default: ReactMarkdown }, { default: CodeBlock }] = await Promise.all([
    import("react-markdown"),
    import("./CodeBlock"),
  ]);
  await harness.render(createElement(ReactMarkdown, {
    components: { pre: CodeBlock },
    children: markdown,
  }));
  return harness;
}

async function copyCode(harness: ReactDomHarness) {
  const button = findAllByTag(harness.dom.container, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.["aria-label"] === "Copy code",
  );
  expect(button).toBeDefined();
  await harness.act(async () => {
    getReactProps(button)?.onClick();
  });
  return button;
}

describe("CodeBlock copying", () => {
  beforeEach(() => {
    clipboardMocks.writeClipboardText.mockReset();
    clipboardMocks.writeClipboardText.mockResolvedValue(undefined);
  });

  it.each([
    ["fenced command", "```sh\nhello\n```", "hello"],
    ["indented code", "    hello", "hello"],
    ["multiple lines", "```text\nhello\nworld\n```", "hello\nworld"],
    ["intentional blank line", "```text\nhello\n\n```", "hello\n"],
    ["multiple intentional blank lines", "```text\nhello\n\n\n```", "hello\n\n"],
    ["spaces and tabs", "```text\n  hello \t\n```", "  hello \t"],
    ["Windows line endings", "```text\r\nhello\r\n```", "hello"],
    ["empty block", "```text\n```", ""],
    ["streaming unclosed block", "```sh\nhello", "hello"],
    ["diff block", "```diff\n@@ -1 +1 @@\n-old\n+new\n```", "@@ -1 +1 @@\n-old\n+new"],
  ])("removes only the renderer-added newline from %s", async (_name, markdown, expected) => {
    const harness = await renderMarkdown(markdown);
    const button = await copyCode(harness);
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(getReactProps(button)?.["aria-label"]).toBe("Copied");
  });

  it.each(["hello", "hello\n", "hello\n\n", "  hello \t\r\n"])(
    "preserves raw file-preview text %j",
    async (text) => {
      const harness = await createReactDomHarness();
      const { default: CodeBlock } = await import("./CodeBlock");
      await harness.render(createElement(CodeBlock, null, createElement("code", null, text)));
      await copyCode(harness);
      expect(clipboardMocks.writeClipboardText).toHaveBeenCalledExactlyOnceWith(text);
    },
  );

  it("still reports clipboard failures", async () => {
    clipboardMocks.writeClipboardText.mockRejectedValue(new Error("Clipboard unavailable"));
    const harness = await renderMarkdown("```sh\nhello\n```");
    const button = await copyCode(harness);
    expect(clipboardMocks.writeClipboardText).toHaveBeenCalledExactlyOnceWith("hello");
    expect(getReactProps(button)?.["aria-label"]).toBe("Copy failed");
  });
});

import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchKind, SearchScope } from "../../shared/search.js";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import SearchQueryInput, { extractSearchTypeFilters, getSearchFilterToken } from "./SearchQueryInput";
import { installDomShim } from "../test-dom-shim";

describe("inline search filters", () => {
  let harness: ReactDomHarness | undefined;
  const scrollIntoView = vi.fn();
  afterEach(async () => { await harness?.cleanup(); });

  it("recognizes named scopes but keeps quoted filter syntax literal", () => {
    expect(getSearchFilterToken("needle task:Bridge Search")).toEqual({ key: "task", value: "Bridge Search", start: 7 });
    expect(getSearchFilterToken('task:"Bridge Search"')?.value).toBe("Bridge Search");
    expect(getSearchFilterToken('"type:task"')).toBeNull();
    expect(getSearchFilterToken('"task:literal" other')).toBeNull();
    expect(getSearchFilterToken("prototype:task")).toBeNull();
    expect(extractSearchTypeFilters('type:task needle "type:doc"')).toEqual({ query: 'needle "type:doc"', kind: "task" });
    expect(extractSearchTypeFilters('"type:task "')).toBeNull();
    expect(extractSearchTypeFilters("type:unknown needle")).toBeNull();
  });

  async function render() {
    const commit = vi.fn();
    function Editor() {
      const [draft, setDraft] = useState("");
      const [kind, setKind] = useState<SearchKind>("all");
      const [scope, setScope] = useState<SearchScope>("global");
      const [taskId, setTaskId] = useState<string>();
      return createElement(SearchQueryInput, {
        draft, kind, scope, taskId,
        tasks: [{ id: "a", title: "Bridge Alpha" }, { id: "b", title: "Bridge Beta" }],
        sessions: [{ id: "chat-1", title: "Conversation" }],
        onChange: setDraft,
        onCommit: (query, filters) => {
          commit(query, filters);
          setDraft(query);
          if (Object.hasOwn(filters, "kind")) setKind(filters.kind as SearchKind || "all");
          if (Object.hasOwn(filters, "scope")) setScope(filters.scope as SearchScope || "global");
          if (Object.hasOwn(filters, "taskId")) setTaskId(filters.taskId ?? undefined);
        },
      });
    }
    harness = await createReactDomHarness({ installDom: () => {
      const dom = installDomShim();
      const originalCreate = document.createElement.bind(document);
      document.createElement = ((tag: string) => {
        const element = originalCreate(tag);
        element.scrollIntoView = scrollIntoView;
        return element;
      }) as typeof document.createElement;
      return { container: dom.container, cleanup() { document.createElement = originalCreate; dom.cleanup(); } };
    } });
    await harness.render(createElement(Editor));
    const input = findAllByTag(harness.dom.container, "INPUT")[0];
    const change = async (value: string) => harness!.act(async () => {
      getReactProps(input)?.onChange?.({ target: { value } });
    });
    const key = async (value: string) => harness!.act(async () => {
      getReactProps(input)?.onKeyDown?.({ key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    return { commit, input, change, key };
  }

  it("commits type shortcuts, preserves text, and removes the chip with Backspace", async () => {
    const { commit, change, key } = await render();
    await change("needle type:task ");
    expect(commit).toHaveBeenLastCalledWith("needle", { kind: "task" });
    expect(harness!.dom.container.textContent).toContain("type:task");
    await change("");
    await key("Backspace");
    expect(commit).toHaveBeenLastCalledWith("", { kind: null });
  });

  it("supports keyboard task selection, named chips, and mutually exclusive chat scope", async () => {
    const { commit, change, key, input } = await render();
    await change("needle task:Bridge");
    expect(getReactProps(input)?.["aria-expanded"]).toBe(true);
    await key("ArrowDown");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    await key("Enter");
    expect(commit).toHaveBeenLastCalledWith("needle", { scope: "task", taskId: "b", sessionId: null });
    expect(harness!.dom.container.textContent).toContain("task:Bridge Beta");
    await change("needle chat:Con");
    await key("Enter");
    expect(commit).toHaveBeenLastCalledWith("needle", { scope: "session", taskId: null, sessionId: "chat-1" });
  });

  it("dismisses only the suggestion list on first Escape and does not commit during IME input", async () => {
    const { commit, change, key, input } = await render();
    await change("type:");
    await key("Escape");
    expect(getReactProps(input)?.["aria-expanded"]).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    await harness!.act(async () => { getReactProps(input)?.onCompositionStart?.(); });
    await change("type:task ");
    await key("Enter");
    expect(commit).not.toHaveBeenCalled();
  });
});

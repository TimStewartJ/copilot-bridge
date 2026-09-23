import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { DraftTextField } from "./DraftTextField";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, String(value)); },
  };
}

const STORAGE_KEY = "bridge-settings-unsaved:identity";
let harness: ReactDomHarness | undefined;

beforeEach(() => { vi.stubGlobal("sessionStorage", memoryStorage()); });
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  vi.unstubAllGlobals();
});

async function renderField(props: { value: string; pending?: boolean; error?: string | null }, onCommit = vi.fn()) {
  harness ??= await createReactDomHarness();
  await harness.render(createElement(DraftTextField, { storageKey: "identity", label: "Identity", onCommit, ...props }));
  return onCommit;
}

const textarea = () => findAllByTag(harness!.dom.container, "INPUT")[0];
const button = (text: string) => findAllByTag(harness!.dom.container, "BUTTON").find((candidate) => candidate.textContent === text);

async function typeAndSave(text: string) {
  await harness!.act(async () => { getReactProps(textarea())?.onChange?.({ target: { value: text } }); });
  await harness!.act(async () => { getReactProps(button("Save"))?.onClick?.(); });
}

describe("DraftTextField", () => {
  it("keeps the attempted text, its unsaved copy and Save when the save fails", async () => {
    const onCommit = await renderField({ value: "old" });
    await typeAndSave("new");
    expect(onCommit).toHaveBeenCalledWith("new");

    await renderField({ value: "new", pending: true }, onCommit);
    expect(button("Save")).toBeUndefined();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("new");

    await renderField({ value: "old", pending: false, error: "Couldn't save identity: offline" }, onCommit);
    expect(getReactProps(textarea())?.value).toBe("new");
    expect(button("Save")).toBeDefined();
    expect(harness!.dom.container.textContent).toContain("Couldn't save identity: offline");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("new");
  });

  it("shows what the server kept and forgets the unsaved copy once it is accepted", async () => {
    const onCommit = await renderField({ value: "old" });
    await typeAndSave("new ");
    await renderField({ value: "new ", pending: true }, onCommit);
    await renderField({ value: "new", pending: false }, onCommit);

    expect(getReactProps(textarea())?.value).toBe("new");
    expect(button("Save")).toBeUndefined();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps text typed after Save while that save is still pending", async () => {
    const onCommit = await renderField({ value: "old" });
    await typeAndSave("new");
    await renderField({ value: "new", pending: true }, onCommit);
    await harness!.act(async () => { getReactProps(textarea())?.onChange?.({ target: { value: "newer" } }); });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("newer");

    await renderField({ value: "new", pending: false }, onCommit);
    expect(getReactProps(textarea())?.value).toBe("newer");
    expect(button("Save")).toBeDefined();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("newer");
  });

  it("follows a new saved value when it has not been edited", async () => {
    await renderField({ value: "old" });
    await renderField({ value: "from elsewhere" });
    expect(getReactProps(textarea())?.value).toBe("from elsewhere");
  });

  it("keeps an edit when the saved value changes underneath it", async () => {
    await renderField({ value: "old" });
    await harness!.act(async () => { getReactProps(textarea())?.onChange?.({ target: { value: "mine" } }); });
    await renderField({ value: "from elsewhere" });
    expect(getReactProps(textarea())?.value).toBe("mine");
  });
});

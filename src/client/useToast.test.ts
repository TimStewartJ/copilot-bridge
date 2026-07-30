import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  flushAct,
  getReactProps,
  type ReactDomHarness,
} from "./test-react-harness";
import { MAX_VISIBLE_TOASTS, ToastProvider, useToast, type ToastContextValue, type ToastInput } from "./useToast";

let api: ToastContextValue | null = null;

function Probe() {
  api = useToast();
  return null;
}

async function mountProvider(): Promise<ReactDomHarness> {
  const harness = await createReactDomHarness();
  await harness.render(createElement(ToastProvider, null, createElement(Probe)));
  return harness;
}

async function show(harness: ReactDomHarness, input: ToastInput): Promise<string> {
  let id = "";
  await harness.act(async () => {
    id = api!.showToast(input);
  });
  return id;
}

function toastTitles(harness: ReactDomHarness): string[] {
  return findAllByTag(harness.dom.container, "DIV")
    .filter((node) => (node.getAttribute("class") ?? "").includes("text-sm font-medium text-text-primary"))
    .map((node) => node.textContent);
}

function findActionButton(harness: ReactDomHarness, label: string) {
  return findAllByTag(harness.dom.container, "BUTTON").find((node) => node.textContent === label);
}

describe("ToastProvider", () => {
  beforeEach(() => {
    api = null;
    vi.useFakeTimers();
  });

  it("renders a shown toast and dismisses it by id", async () => {
    const harness = await mountProvider();

    const id = await show(harness, { title: "Unlinked WI-1" });
    expect(toastTitles(harness)).toContain("Unlinked WI-1");

    await harness.act(async () => { api!.dismissToast(id); });
    expect(toastTitles(harness)).toHaveLength(0);
  });

  it("auto-dismisses after the requested duration", async () => {
    const harness = await mountProvider();

    await show(harness, { title: "Temporary", durationMs: 1_000 });
    expect(toastTitles(harness)).toContain("Temporary");

    await harness.act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(toastTitles(harness)).toHaveLength(0);
  });

  it("keeps a toast open when durationMs is 0", async () => {
    const harness = await mountProvider();

    await show(harness, { title: "Sticky", durationMs: 0 });
    await harness.act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(toastTitles(harness)).toContain("Sticky");
  });

  it("replaces a toast that reuses the same id instead of stacking", async () => {
    const harness = await mountProvider();

    await show(harness, { id: "same", title: "First" });
    await show(harness, { id: "same", title: "Second" });

    expect(toastTitles(harness)).toEqual(["Second"]);
  });

  it("evicts the oldest toasts beyond the visible cap", async () => {
    const harness = await mountProvider();

    for (let index = 0; index < MAX_VISIBLE_TOASTS + 2; index += 1) {
      await show(harness, { title: `Toast ${index}`, durationMs: 0 });
    }

    const titles = toastTitles(harness);
    expect(titles).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(titles).not.toContain("Toast 0");
    expect(titles).toContain(`Toast ${MAX_VISIBLE_TOASTS + 1}`);
  });

  it("holds the toast open while its action runs and shows the pending label", async () => {
    const harness = await mountProvider();
    let release: (() => void) | undefined;
    const onAction = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    await show(harness, {
      title: "Unlinked WI-1",
      durationMs: 1_000,
      action: { label: "Undo", pendingLabel: "Restoring…", onAction },
    });

    const undoButton = findActionButton(harness, "Undo");
    await harness.act(async () => {
      getReactProps(undoButton)?.onClick?.({ currentTarget: undoButton });
    });

    expect(onAction).toHaveBeenCalledOnce();
    expect(findActionButton(harness, "Restoring…")).toBeDefined();

    // The auto-dismiss timer must not fire while the undo is still in flight.
    await harness.act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(toastTitles(harness)).toContain("Unlinked WI-1");

    await harness.act(async () => { release?.(); });
    await flushAct(harness.act);
    expect(findActionButton(harness, "Undo")).toBeDefined();
  });

  it("re-arms auto-dismiss after an action finishes without dismissing", async () => {
    const harness = await mountProvider();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await show(harness, {
      title: "Unlinked WI-1",
      durationMs: 1_000,
      action: { label: "Undo", onAction: () => { throw new Error("undo failed"); } },
    });

    const undoButton = findActionButton(harness, "Undo");
    await harness.act(async () => {
      getReactProps(undoButton)?.onClick?.({ currentTarget: undoButton });
    });
    await flushAct(harness.act);
    expect(toastTitles(harness)).toContain("Unlinked WI-1");

    await harness.act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(toastTitles(harness)).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("clears the timer of a toast evicted by the visible cap", async () => {
    const harness = await mountProvider();

    await show(harness, { title: "Evicted", durationMs: 1_000 });
    for (let index = 0; index < MAX_VISIBLE_TOASTS; index += 1) {
      await show(harness, { title: `Filler ${index}`, durationMs: 0 });
    }
    await flushAct(harness.act);
    expect(toastTitles(harness)).not.toContain("Evicted");

    // The evicted toast's timer must not fire and remove a still-live toast.
    await harness.act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(toastTitles(harness)).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it("updates an existing toast in place", async () => {
    const harness = await mountProvider();

    const id = await show(harness, { title: "Before", durationMs: 0 });
    await harness.act(async () => { api!.updateToast(id, { title: "After" }); });

    expect(toastTitles(harness)).toEqual(["After"]);
  });
});

describe("useToast outside a provider", () => {
  it("degrades to no-ops instead of throwing", async () => {
    const harness = await createReactDomHarness();
    await harness.render(createElement(Probe));

    expect(() => api!.showToast({ title: "ignored" })).not.toThrow();
    expect(api!.showToast({ title: "ignored" })).toBe("");
    expect(() => api!.dismissToast("nope")).not.toThrow();
    expect(() => api!.updateToast("nope", { title: "x" })).not.toThrow();
  });
});

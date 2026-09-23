import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { TaskReorderBar, useTaskReorderMode } from "./TaskReorderBar";

type Mode = ReturnType<typeof useTaskReorderMode>;

describe("useTaskReorderMode", () => {
  let harness: ReactDomHarness | null = null;
  let keydown: ((event: { key: string }) => void) | null = null;
  let keydownCapture: unknown = undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    keydown = null;
    vi.restoreAllMocks();
  });

  type ModeProps = Parameters<typeof useTaskReorderMode>[0];

  async function renderMode(props: ModeProps) {
    harness ??= await createReactDomHarness();
    const add = window.addEventListener;
    vi.spyOn(window, "addEventListener").mockImplementation(((type: string, listener: EventListener, options?: unknown) => {
      if (type === "keydown") {
        keydown = listener as unknown as (event: { key: string }) => void;
        keydownCapture = options;
      }
      else add.call(window, type, listener);
    }) as typeof window.addEventListener);
    vi.spyOn(window, "removeEventListener").mockImplementation(((type: string) => {
      if (type === "keydown") keydown = null;
    }) as typeof window.removeEventListener);
    const ref: { current: Mode | null } = { current: null };
    function Probe(probeProps: typeof props) {
      ref.current = useTaskReorderMode(probeProps);
      return null;
    }
    await harness.render(createElement(Probe, props));
    return {
      mode: () => ref.current!,
      rerender: (next: typeof props) => harness!.render(createElement(Probe, next)),
    };
  }

  it("ends on Escape when no drag is in progress, and tells the list", async () => {
    const onExit = vi.fn();
    const { mode } = await renderMode({ enabled: true, dragging: false, onExit });
    await harness!.act(async () => mode().start());
    expect(mode().reordering).toBe(true);
    // Capture phase, so dnd-kit's Escape-cancels-drag handler cannot run (and clear `dragging`) first.
    expect(keydownCapture).toBe(true);
    await harness!.act(async () => keydown?.({ key: "Escape" }));
    expect(mode().reordering).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("leaves Escape to cancel an active drag and stays on", async () => {
    const { mode, rerender } = await renderMode({ enabled: true, dragging: false });
    await harness!.act(async () => mode().start());
    await rerender({ enabled: true, dragging: true });
    await harness!.act(async () => keydown?.({ key: "Escape" }));
    expect(mode().reordering).toBe(true);
  });

  it("ends by itself when reordering stops being possible", async () => {
    const onExit = vi.fn();
    const { mode, rerender } = await renderMode({ enabled: true, dragging: false, onExit });
    await harness!.act(async () => mode().start());
    await rerender({ enabled: false, dragging: false, onExit });
    expect(mode().reordering).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
    await rerender({ enabled: true, dragging: false, onExit });
    expect(mode().reordering).toBe(false);
  });
});

describe("useTaskReorderMode focus", () => {
  it("returns focus after Done or Escape, but not when the list itself went away", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const focus = vi.fn();
    const returnFocusRef = { current: { focus } as unknown as HTMLElement };
    const harness = await createReactDomHarness();
    try {
      const ref: { current: Mode | null } = { current: null };
      function Probe({ enabled }: { enabled: boolean }) {
        ref.current = useTaskReorderMode({ enabled, dragging: false, returnFocusRef });
        return null;
      }
      await harness.render(createElement(Probe, { enabled: true }));
      await harness.act(async () => ref.current!.start());
      await harness.act(async () => ref.current!.stop());
      frames.splice(0).forEach((cb) => cb(0));
      expect(focus).toHaveBeenCalledOnce();

      await harness.act(async () => ref.current!.start());
      await harness.render(createElement(Probe, { enabled: false }));
      frames.splice(0).forEach((cb) => cb(0));
      expect(ref.current!.reordering).toBe(false);
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
      vi.restoreAllMocks();
    }
  });
});

describe("TaskReorderBar", () => {
  it("says what to do and finishes on Done", async () => {
    const harness = await createReactDomHarness();
    try {
      const onDone = vi.fn();
      await harness.render(createElement(TaskReorderBar, { onDone }));
      expect(harness.dom.container.textContent).toContain("Drag the handles to reorder");
      const done = findAllByTag(harness.dom.container, "BUTTON").find((button) => button.textContent === "Done");
      await harness.act(async () => getReactProps(done)?.onClick?.());
      expect(onDone).toHaveBeenCalledOnce();
    } finally { await harness.cleanup(); }
  });
});

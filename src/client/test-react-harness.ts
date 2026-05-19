import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";
import { installDomShim } from "./test-dom-shim";

export type Act = (callback: () => void | Promise<void>) => Promise<void>;
type DomShim = ReturnType<typeof installDomShim>;

type CreateReactDomHarnessOptions = {
  installDom?: () => DomShim;
};

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
type HarnessCleanup = () => Promise<void>;
const activeHarnessCleanups = new Set<HarnessCleanup>();

async function cleanupActiveHarnesses(): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of [...activeHarnessCleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to clean up React DOM harnesses");
  }
}

afterEach(async () => {
  try {
    await cleanupActiveHarnesses();
  } finally {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }
});

async function withRealTimersForHarnessCleanup(callback: () => Promise<void>): Promise<void> {
  const hadFakeTimers = vi.isFakeTimers();
  if (!hadFakeTimers) {
    await callback();
    return;
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  try {
    await callback();
  } finally {
    vi.useFakeTimers();
  }
}

export async function createReactDomHarness(options: CreateReactDomHarnessOptions = {}) {
  const dom = (options.installDom ?? installDomShim)();
  try {
    // Keep these imports after the DOM shim is installed. React DOM probes the
    // test environment during import/render, so top-level imports can reintroduce
    // the global-ordering bugs this harness is meant to avoid.
    const [{ createRoot }, { act }] = await Promise.all([
      import("react-dom/client"),
      import("react"),
    ]);
    const testAct = act as Act;
    const root = createRoot(dom.container as unknown as Element);
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeHarnessCleanups.delete(cleanup);
      try {
        await withRealTimersForHarnessCleanup(async () => {
          await testAct(async () => {
            root.unmount();
          });
          await flushAct(testAct);
        });
      } finally {
        dom.cleanup();
      }
    };
    activeHarnessCleanups.add(cleanup);

    return {
      dom,
      act: testAct,
      async render(element: ReactNode) {
        await testAct(async () => {
          root.render(element);
        });
      },
      cleanup,
    };
  } catch (error) {
    dom.cleanup();
    throw error;
  }
}

export type ReactDomHarness = Awaited<ReturnType<typeof createReactDomHarness>>;

export function findAllByTag(root: any, tag: string): any[] {
  const results: any[] = [];
  if ((root.tagName ?? "").toUpperCase() === tag.toUpperCase()) results.push(root);
  for (const child of root.childNodes ?? []) {
    results.push(...findAllByTag(child, tag));
  }
  return results;
}

export function getReactProps(el: any): Record<string, any> | null {
  if (!el) return null;
  const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? el[key] : null;
}

export async function waitTick(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(1);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function flushAct(act: Act, ticks = 1): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await act(async () => {
      await waitTick();
    });
  }
}

export async function waitForDelayAct(act: Act, delayMs: number): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(delayMs);
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  });
}

export async function waitUntilAct(
  act: Act,
  predicate: () => boolean,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await flushAct(act);
  }
  throw new Error("Timed out waiting for condition");
}

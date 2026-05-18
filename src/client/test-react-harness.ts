import type { ReactNode } from "react";
import { vi } from "vitest";
import { installDomShim } from "./test-dom-shim";

export type Act = (callback: () => void | Promise<void>) => Promise<void>;
type DomShim = ReturnType<typeof installDomShim>;

type CreateReactDomHarnessOptions = {
  installDom?: () => DomShim;
};

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

export async function createReactDomHarness(options: CreateReactDomHarnessOptions = {}) {
  const dom = (options.installDom ?? installDomShim)();
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

  return {
    dom,
    act: testAct,
    async render(element: ReactNode) {
      await testAct(async () => {
        root.render(element);
      });
    },
    async cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await testAct(async () => {
          root.unmount();
        });
        await flushAct(testAct);
      } finally {
        dom.cleanup();
      }
    },
  };
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

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { advanceTimersByTimeAct, createReactDomHarness, findAllByTag, getReactProps, waitTick } from "./test-react-harness";
import { installSelectAwareDomShim } from "./test-dom-shim";

export function installFocusDialogDom() {
  const dom = installSelectAwareDomShim();
  const originalCreate = document.createElement.bind(document);
  const matchingChildren = (root: Element, selector: string): Element[] => {
    const selectors = selector.split(",").map((value) => value.trim());
    const matches = (element: Element) => selectors.some((value) => {
      const tag = value.replace(":not([disabled])", "").replace("[href]", "").toUpperCase();
      return element.tagName === tag
        && (!value.includes("[href]") || element.getAttribute("href") !== null)
        && (!value.includes(":not([disabled])") || (element.getAttribute("disabled") === null && !("disabled" in element && element.disabled)));
    });
    const children = Array.from(root.childNodes).filter((node): node is Element => node.nodeType === 1);
    return children.flatMap((child) => [...(matches(child) ? [child] : []), ...matchingChildren(child, selector)]);
  };
  document.createElement = ((tag: string) => {
    const element = originalCreate(tag);
    Object.defineProperty(element, "parentElement", { configurable: true, get: () => element.parentNode?.nodeType === 1 ? element.parentNode : null });
    Object.defineProperty(element, "children", { configurable: true, get: () => Array.from(element.childNodes).filter((node) => node.nodeType === 1) });
    Object.defineProperty(element, "querySelector", { configurable: true, value: (selector: string) => matchingChildren(element, selector)[0] ?? null });
    Object.defineProperty(element, "querySelectorAll", { configurable: true, value: (selector: string) => matchingChildren(element, selector) });
    return element;
  }) as typeof document.createElement;
  return { container: dom.container, cleanup() { document.createElement = originalCreate; dom.cleanup(); } };
}

export async function createFocusTestHarness() {
  const harness = await createReactDomHarness({ installDom: installFocusDialogDom });
  const queryClient = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    mutations: { retry: false },
  } });
  return {
    ...harness,
    queryClient,
    async render(node: ReactNode) {
      await harness.render(createElement(QueryClientProvider, { client: queryClient }, node));
      await harness.act(waitTick);
      if (vi.isFakeTimers()) await advanceTimersByTimeAct(harness.act, 1);
    },
    async cleanup() {
      await harness.cleanup();
      queryClient.clear();
    },
  };
}

export type FocusTestHarness = Awaited<ReturnType<typeof createFocusTestHarness>>;

export function focusButton(root: any, label: string): any {
  const buttons = findAllByTag(root, "BUTTON").filter((button) => button.textContent === label || getReactProps(button)?.["aria-label"] === label);
  if (buttons.length !== 1) throw new Error(`Expected one button "${label}", found ${buttons.length}`);
  return buttons[0];
}

export async function clickFocusButton(harness: FocusTestHarness, label: string): Promise<void> {
  await harness.act(async () => {
    getReactProps(focusButton(harness.dom.container, label))?.onClick?.({ preventDefault() {}, stopPropagation() {} });
    await waitTick();
  });
  if (vi.isFakeTimers()) await advanceTimersByTimeAct(harness.act, 1);
}

export async function changeFocusField(harness: FocusTestHarness, label: string, value: string): Promise<void> {
  const container = findAllByTag(harness.dom.container, "LABEL").find((node) => node.textContent.startsWith(label));
  if (!container) throw new Error(`Field label missing: ${label}`);
  const field = [...findAllByTag(container, "TEXTAREA"), ...findAllByTag(container, "SELECT"), ...findAllByTag(container, "INPUT")][0];
  if (!field) throw new Error(`Field missing: ${label}`);
  await harness.act(async () => {
    getReactProps(field)?.onChange?.({ target: { value } });
    await waitTick();
  });
  if (vi.isFakeTimers()) await advanceTimersByTimeAct(harness.act, 1);
}

export async function submitFocusForm(harness: FocusTestHarness): Promise<void> {
  const form = findAllByTag(harness.dom.container, "FORM").at(-1);
  if (!form) throw new Error("Form missing");
  await harness.act(async () => {
    getReactProps(form)?.onSubmit?.({ preventDefault() {} });
    await waitTick();
  });
  if (vi.isFakeTimers()) await advanceTimersByTimeAct(harness.act, 1);
}

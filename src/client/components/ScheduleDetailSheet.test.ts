import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import { installDomShim } from "../test-dom-shim";
import ScheduleDetailSheet from "./ScheduleDetailSheet";

const apiMocks = vi.hoisted(() => ({
  createSchedule: vi.fn(),
  patchSchedule: vi.fn(),
  fetchServerTimezone: vi.fn(),
  getSessionRunState: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

vi.mock("../hooks/queries/useScheduleSessions", () => ({
  useScheduleSessionsQuery: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}));

const NOW = new Date("2026-06-15T17:40:30.000Z");

function toDatetimeLocalValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function findRunAtInput(harness: ReactDomHarness): any {
  const input = findAllByTag(harness.dom.container, "INPUT").find(
    (candidate) => getReactProps(candidate)?.type === "datetime-local",
  );
  if (!input) throw new Error("Run-at input not found");
  return input;
}

function findButtonByText(harness: ReactDomHarness, text: string): any {
  const button = findAllByTag(harness.dom.container, "BUTTON").find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(harness: ReactDomHarness, text: string) {
  const button = findButtonByText(harness, text);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.({ stopPropagation() {} });
  });
}

async function setRunAt(harness: ReactDomHarness, value: string) {
  const input = findRunAtInput(harness);
  await harness.act(async () => {
    await getReactProps(input)?.onChange?.({ target: { value } });
  });
}

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & {
    createElement: (tag: string) => any;
  };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () =>
          Array.from(element.childNodes ?? []).filter((child: any) => child.tagName === "OPTION"),
      });
    }
    if (normalizedTag === "OPTION") {
      Object.defineProperty(element, "value", {
        configurable: true,
        get: () => element.getAttribute("value") ?? element.textContent ?? "",
        set: (value) => element.setAttribute("value", String(value)),
      });
      Object.defineProperty(element, "selected", { configurable: true, writable: true, value: false });
    }
    return element;
  };

  return {
    container: dom.container,
    cleanup() {
      documentRef.createElement = originalCreateElement;
      dom.cleanup();
    },
  };
}

async function fillNameAndPrompt(harness: ReactDomHarness) {
  const nameInput = findAllByTag(harness.dom.container, "INPUT")[0];
  await harness.act(async () => {
    await getReactProps(nameInput)?.onChange?.({ target: { value: "Future run" } });
  });
  const textarea = findAllByTag(harness.dom.container, "TEXTAREA")[0];
  await harness.act(async () => {
    await getReactProps(textarea)?.onChange?.({ target: { value: "Do the thing" } });
  });
}

async function renderCreateSheet() {
  const onSaved = vi.fn();
  const noop = vi.fn();
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  await harness.render(
    createElement(ScheduleDetailSheet, {
      schedule: null,
      taskId: "task-1",
      mode: "create",
      onClose: noop,
      onSwitchToEdit: noop,
      onSwitchToView: noop,
      onTrigger: noop,
      onToggle: noop,
      onDelete: noop,
      onSaved,
    }),
  );
  // Switch to the one-time schedule mode.
  await clickButton(harness, "One-time");
  return { harness, onSaved };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  apiMocks.createSchedule.mockReset();
  apiMocks.createSchedule.mockResolvedValue(undefined);
  apiMocks.patchSchedule.mockReset();
  apiMocks.patchSchedule.mockResolvedValue(undefined);
  apiMocks.fetchServerTimezone.mockReset();
  apiMocks.fetchServerTimezone.mockResolvedValue("UTC");
  apiMocks.getSessionRunState.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ScheduleDetailSheet one-time run-at guard", () => {
  it("sets the run-at input min to the current minute", async () => {
    const { harness } = await renderCreateSheet();
    try {
      const input = findRunAtInput(harness);
      expect(getReactProps(input)?.min).toBe(toDatetimeLocalValue(NOW));
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a past run-at with an inline error and does not save", async () => {
    const { harness, onSaved } = await renderCreateSheet();
    try {
      await fillNameAndPrompt(harness);
      const past = toDatetimeLocalValue(new Date(NOW.getTime() - 24 * 60 * 60_000));
      await setRunAt(harness, past);

      await clickButton(harness, "Create Schedule");

      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Run time must be in the future"),
      );
      expect(apiMocks.createSchedule).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts a future run-at and creates the schedule", async () => {
    const { harness, onSaved } = await renderCreateSheet();
    try {
      await fillNameAndPrompt(harness);

      const future = toDatetimeLocalValue(new Date(NOW.getTime() + 24 * 60 * 60_000));
      await setRunAt(harness, future);

      await clickButton(harness, "Create Schedule");

      await waitUntilAct(harness.act, () => apiMocks.createSchedule.mock.calls.length > 0);
      expect(apiMocks.createSchedule).toHaveBeenCalledOnce();
      const input = apiMocks.createSchedule.mock.calls[0][0];
      expect(input.type).toBe("once");
      expect(input.runAt).toBe(new Date(future).toISOString());
      expect(harness.dom.container.textContent ?? "").not.toContain("Run time must be in the future");
      await waitUntilAct(harness.act, () => onSaved.mock.calls.length > 0);
      expect(onSaved).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});

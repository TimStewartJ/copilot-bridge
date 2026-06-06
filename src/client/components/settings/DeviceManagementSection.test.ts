import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import { installDomShim } from "../../test-dom-shim";
import { DeviceManagementSection } from "./DeviceManagementSection";

const apiMocks = vi.hoisted(() => ({
  hibernateDevice: vi.fn(),
  fetchHibernateStatus: vi.fn(),
  cancelHibernate: vi.fn(),
}));

vi.mock("../../api", () => ({
  ...apiMocks,
  HIBERNATE_DELAY_MINUTES: [0, 5, 15, 30, 60],
}));

const NOW = new Date("2026-06-06T12:00:00.000Z");

function idleStatus() {
  return { pending: false, scheduledAt: null, delayMs: null };
}

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(harness: ReactDomHarness, text: string) {
  const button = findButtonByText(harness.dom.container, text);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.({ stopPropagation() {} });
  });
}

async function setDelay(harness: ReactDomHarness, value: number) {
  const select = findAllByTag(harness.dom.container, "SELECT")[0];
  await harness.act(async () => {
    await getReactProps(select)?.onChange?.({ target: { value: String(value) } });
  });
}

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & { createElement: (tag: string) => any };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () => Array.from(element.childNodes ?? []).filter((child: any) => child.tagName === "OPTION"),
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

async function renderSection() {
  const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  (globalThis.window as unknown as { confirm: () => boolean }).confirm = vi.fn(() => true);
  await harness.render(createElement(DeviceManagementSection));
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  apiMocks.hibernateDevice.mockReset();
  apiMocks.fetchHibernateStatus.mockReset();
  apiMocks.fetchHibernateStatus.mockResolvedValue(idleStatus());
  apiMocks.cancelHibernate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DeviceManagementSection", () => {
  it("restores a pending scheduled hibernation on mount and cancels it", async () => {
    apiMocks.fetchHibernateStatus.mockResolvedValue({
      pending: true,
      scheduledAt: NOW.getTime() + 5 * 60_000,
      delayMs: 5 * 60_000,
    });
    apiMocks.cancelHibernate.mockResolvedValue({
      ok: true,
      cancelled: true,
      pending: false,
      scheduledAt: null,
      delayMs: null,
    });

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Hibernating in"),
      );
      expect(harness.dom.container.textContent ?? "").toContain("5m 00s");

      await clickButton(harness, "Cancel");

      expect(apiMocks.cancelHibernate).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Scheduled hibernation cancelled"),
      );
      expect(harness.dom.container.textContent ?? "").not.toContain("Hibernating in");
    } finally {
      await harness.cleanup();
    }
  });

  it("schedules a delayed hibernation from the dropdown", async () => {
    apiMocks.hibernateDevice.mockResolvedValue({
      ok: true,
      pending: true,
      scheduledAt: NOW.getTime() + 5 * 60_000,
      delayMs: 5 * 60_000,
      message: "Hibernate scheduled in 5 minutes. The device will sleep then unless cancelled.",
    });

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "SELECT").length > 0);
      await setDelay(harness, 5);

      await clickButton(harness, "Schedule");

      expect(apiMocks.hibernateDevice).toHaveBeenCalledWith(5);
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Hibernating in"),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("hibernates immediately by default", async () => {
    apiMocks.hibernateDevice.mockResolvedValue({
      ok: true,
      pending: false,
      scheduledAt: null,
      delayMs: null,
      message: "Hibernate requested. This device may sleep shortly.",
    });

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "BUTTON").length > 0);
      await clickButton(harness, "Hibernate");

      expect(apiMocks.hibernateDevice).toHaveBeenCalledWith(0);
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("This device may sleep shortly"),
      );
      expect(harness.dom.container.textContent ?? "").not.toContain("Hibernating in");
    } finally {
      await harness.cleanup();
    }
  });
});

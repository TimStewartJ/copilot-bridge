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
import { HostPowerSection } from "./HostPowerSection";

const apiMocks = vi.hoisted(() => ({
  hibernateDevice: vi.fn(),
  fetchHibernateStatus: vi.fn(),
  cancelHibernate: vi.fn(),
  setHibernateOnIdle: vi.fn(),
}));

vi.mock("../../api", () => ({
  ...apiMocks,
  HIBERNATE_DELAY_MINUTES: [0, 5, 15, 30, 60],
  HIBERNATE_IDLE_GRACE_MINUTES: 2,
}));

const NOW = new Date("2026-06-06T12:00:00.000Z");

function idleStatus() {
  return { pending: false, scheduledAt: null, delayMs: null };
}

function disarmedOnIdle() {
  return {
    armed: false,
    armedAt: null,
    graceMs: null,
    activeSessions: 0,
    idleSince: null,
    hibernateAt: null,
    blockedReason: null,
  };
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
  await harness.render(createElement(HostPowerSection));
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  apiMocks.hibernateDevice.mockReset();
  apiMocks.fetchHibernateStatus.mockReset();
  apiMocks.fetchHibernateStatus.mockResolvedValue(idleStatus());
  apiMocks.cancelHibernate.mockReset();
  apiMocks.setHibernateOnIdle.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HostPowerSection", () => {
  it("restores a pending scheduled hibernation on mount and cancels it", async () => {
    const scheduled = {
      pending: true,
      scheduledAt: NOW.getTime() + 5 * 60_000,
      delayMs: 5 * 60_000,
    };
    apiMocks.fetchHibernateStatus.mockResolvedValue(scheduled);
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

      let finishRead!: (value: typeof scheduled) => void;
      apiMocks.fetchHibernateStatus.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      await harness.render(createElement(HostPowerSection, { refreshSignal: 1 }));
      await clickButton(harness, "Cancel");
      await harness.act(async () => { finishRead(scheduled); });

      expect(apiMocks.cancelHibernate).toHaveBeenCalledOnce();
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Scheduled hibernation cancelled"),
      );
      expect(harness.dom.container.textContent ?? "").not.toContain("Hibernating in");
    } finally {
      await harness.cleanup();
    }
  });

  it("refreshes external power changes without resetting the chosen delay", async () => {
    const harness = await renderSection();
    try {
      await setDelay(harness, 15);
      const refresh = (refreshSignal: number) => harness.render(createElement(HostPowerSection, { refreshSignal }));
      apiMocks.fetchHibernateStatus.mockResolvedValueOnce({
        pending: true,
        scheduledAt: NOW.getTime() + 5 * 60_000,
        delayMs: 5 * 60_000,
        onIdle: disarmedOnIdle(),
      });
      await refresh(1);
      expect(harness.dom.container.textContent).toContain("5m 00s");

      apiMocks.fetchHibernateStatus.mockRejectedValueOnce(new Error("Host unreachable"));
      await refresh(2);
      expect(harness.dom.container.textContent).toContain("Host unreachable");
      expect(harness.dom.container.textContent).toContain("5m 00s");

      apiMocks.fetchHibernateStatus.mockResolvedValueOnce({
        ...idleStatus(),
        onIdle: { ...disarmedOnIdle(), armed: true, activeSessions: 2 },
      });
      await refresh(3);
      expect(harness.dom.container.textContent).not.toContain("Hibernating in");
      expect(harness.dom.container.textContent).not.toContain("Host unreachable");
      expect(harness.dom.container.textContent).toContain("2 active sessions");

      await refresh(4);
      expect(harness.dom.container.textContent).not.toContain("On idle: on");
      expect(findButtonByText(harness.dom.container, "Schedule")).toBeTruthy();
      expect(apiMocks.hibernateDevice).not.toHaveBeenCalled();
      expect(apiMocks.cancelHibernate).not.toHaveBeenCalled();
      expect(apiMocks.setHibernateOnIdle).not.toHaveBeenCalled();
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
      onIdle: disarmedOnIdle(),
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

  it("arms on idle without losing an externally scheduled hibernation", async () => {
    const armed = {
      ok: true,
      disarmed: false,
      armed: true,
      armedAt: NOW.getTime(),
      graceMs: 2 * 60_000,
      activeSessions: 2,
      idleSince: null,
      hibernateAt: null,
      message: "Hibernate on idle armed.",
    };
    apiMocks.setHibernateOnIdle.mockResolvedValue(armed);

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "BUTTON").length > 0);
      apiMocks.fetchHibernateStatus.mockResolvedValue({
        pending: true,
        scheduledAt: NOW.getTime() + 5 * 60_000,
        delayMs: 5 * 60_000,
        onIdle: armed,
      });
      await clickButton(harness, "On idle");

      expect(apiMocks.setHibernateOnIdle).toHaveBeenCalledWith(true);
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("2 active sessions"),
      );
      expect(harness.dom.container.textContent ?? "").toContain("On idle: on");
      expect(harness.dom.container.textContent ?? "").toContain("5m 00s");
      expect(harness.dom.container.textContent ?? "").not.toContain("All sessions idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("explains a deploy or restart hold instead of the idle countdown", async () => {
    apiMocks.fetchHibernateStatus.mockResolvedValue({
      ...idleStatus(),
      onIdle: {
        armed: true,
        armedAt: NOW.getTime() - 60_000,
        graceMs: 2 * 60_000,
        activeSessions: 0,
        idleSince: null,
        hibernateAt: null,
        blockedReason: "A staging_deploy management job is running",
      },
    });

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("held because"),
      );
      const text = harness.dom.container.textContent ?? "";
      expect(text).toContain("a staging_deploy management job is running");
      // Zero active sessions must not read as "about to hibernate".
      expect(text).not.toContain("All sessions idle");
      expect(text).not.toContain("waiting for all sessions to go idle");
    } finally {
      await harness.cleanup();
    }
  });

  it("restores an armed idle watcher on mount, counts down, and turns it off", async () => {
    apiMocks.fetchHibernateStatus.mockResolvedValueOnce({
      ...idleStatus(),
      onIdle: {
        armed: true,
        armedAt: NOW.getTime() - 60_000,
        graceMs: 2 * 60_000,
        activeSessions: 0,
        idleSince: NOW.getTime(),
        hibernateAt: NOW.getTime() + 2 * 60_000,
      },
    });
    apiMocks.setHibernateOnIdle.mockResolvedValue({
      ok: true,
      disarmed: true,
      ...disarmedOnIdle(),
      message: "Hibernate on idle turned off.",
    });

    const harness = await renderSection();
    try {
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("All sessions idle"),
      );
      expect(harness.dom.container.textContent ?? "").toContain("2m 00s");

      await clickButton(harness, "Turn off");

      expect(apiMocks.setHibernateOnIdle).toHaveBeenCalledWith(false);
      await waitUntilAct(harness.act, () =>
        (harness.dom.container.textContent ?? "").includes("Hibernate on idle turned off"),
      );
      expect(harness.dom.container.textContent ?? "").not.toContain("All sessions idle");
      expect(harness.dom.container.textContent ?? "").toContain("On idle");
    } finally {
      await harness.cleanup();
    }
  });
});

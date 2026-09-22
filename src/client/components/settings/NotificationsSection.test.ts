import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPushState } from "../../push-notifications";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";

const pushMocks = vi.hoisted(() => ({
  disablePushNotifications: vi.fn(),
  enablePushNotifications: vi.fn(),
  getClientPushState: vi.fn(),
  sendCurrentSubscriptionTestNotification: vi.fn(),
}));

vi.mock("../../push-notifications", () => pushMocks);

const settingsMocks = vi.hoisted(() => ({
  useSettingsQuery: vi.fn(),
  mutateAsync: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("../../hooks/queries/useSettings", () => ({
  useSettingsQuery: settingsMocks.useSettingsQuery,
  useSettingsMutation: () => ({ mutateAsync: settingsMocks.mutateAsync }),
}));

import { NotificationsSection } from "./NotificationsSection";

function pushState(overrides: Partial<ClientPushState> = {}): ClientPushState {
  return {
    support: { supported: true, reasons: [] },
    permission: "granted",
    server: {
      configured: true,
      publicKey: "public-key",
      subject: "mailto:test@example.com",
      missingEnv: [],
      subscriptionCount: 1,
    },
    subscribed: true,
    endpoint: "https://push.example.test/subscription",
    ...overrides,
  };
}

describe("NotificationsSection", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    pushMocks.getClientPushState.mockResolvedValue(pushState());
    pushMocks.enablePushNotifications.mockResolvedValue({});
    pushMocks.disablePushNotifications.mockResolvedValue({});
    pushMocks.sendCurrentSubscriptionTestNotification.mockResolvedValue({ sent: 1 });
    settingsMocks.useSettingsQuery.mockReturnValue({
      data: { mcpServers: {} },
      error: null,
      isFetching: false,
      refetch: settingsMocks.refetch,
    });
    settingsMocks.refetch.mockResolvedValue({});
    settingsMocks.mutateAsync.mockResolvedValue({ mcpServers: {} });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    vi.clearAllMocks();
  });

  async function render() {
    harness = await createReactDomHarness();
    await harness.render(createElement(NotificationsSection));
    await waitUntilAct(harness.act, () => !getReactProps(button("Refresh"))!.disabled);
  }

  function button(text: string) {
    const node = findAllByTag(harness!.dom.container, "BUTTON")
      .find((candidate) => candidate.textContent?.trim() === text);
    if (!node) throw new Error(`Button not found: ${text}`);
    return node;
  }

  async function click(text: string) {
    await harness!.act(async () => {
      getReactProps(button(text))!.onClick();
    });
    await waitUntilAct(harness!.act, () => !getReactProps(button("Refresh"))!.disabled);
  }

  it("describes native question notifications without retaining dashboard policy", async () => {
    await render();

    expect(harness!.dom.container.textContent).toContain("Routine completions stay in their task and do not interrupt you.");
    expect(harness!.dom.container.textContent).toContain("Session notifications are for conversations requesting your input.");
    expect(harness!.dom.container.textContent).toContain("Home does not grant additional notification authority.");
    expect(harness!.dom.container.textContent).not.toContain("Focus");
  });

  it("retains enable, disable, test and refresh controls without mutating policy", async () => {
    await render();
    await click("Send test");
    expect(pushMocks.sendCurrentSubscriptionTestNotification).toHaveBeenCalledOnce();
    await click("Disable");
    expect(pushMocks.disablePushNotifications).toHaveBeenCalledOnce();
    await click("Enable");
    expect(pushMocks.enablePushNotifications).toHaveBeenCalledExactlyOnceWith(pushState().server);
    await click("Refresh");
    expect(pushMocks.getClientPushState).toHaveBeenCalledTimes(5);
    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
    expect(settingsMocks.refetch).not.toHaveBeenCalled();
    for (const label of ["Enable", "Disable", "Send test", "Refresh"]) {
      expect(getReactProps(button(label))!.className).toContain("h-10");
    }
  });

  it("does not depend on a dashboard-policy query for native push controls", async () => {
    settingsMocks.useSettingsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Policy service unavailable"),
      isFetching: false,
      refetch: settingsMocks.refetch,
    });
    await render();

    expect(harness!.dom.container.textContent).not.toContain("Policy service unavailable");
    expect(findAllByTag(harness!.dom.container, "INPUT")).toHaveLength(0);
    expect(getReactProps(button("Send test"))!.disabled).toBe(false);
    expect(settingsMocks.refetch).not.toHaveBeenCalled();
    await click("Send test");
    await click("Disable");
    await click("Enable");
    expect(pushMocks.sendCurrentSubscriptionTestNotification).toHaveBeenCalledOnce();
    expect(pushMocks.disablePushNotifications).toHaveBeenCalledOnce();
    expect(pushMocks.enablePushNotifications).toHaveBeenCalledOnce();
  });

  it.each([
    { state: pushState({ support: { supported: false, reasons: ["HTTPS is required."] }, subscribed: false }), message: "HTTPS is required." },
    { state: pushState({ permission: "denied", subscribed: false }), message: "Notifications are blocked" },
    { state: pushState({ server: { ...pushState().server!, configured: false, missingEnv: ["VAPID_PUBLIC_KEY"] }, subscribed: false }), message: "VAPID_PUBLIC_KEY" },
  ])("retains unavailable push reasons while keeping policy editing independent ($message)", async ({ state, message }) => {
    pushMocks.getClientPushState.mockResolvedValue(state);
    await render();

    expect(harness!.dom.container.textContent).toContain(message);
    expect(getReactProps(button("Enable"))!.disabled).toBe(true);
    expect(getReactProps(button("Disable"))!.disabled).toBe(true);
    expect(getReactProps(button("Send test"))!.disabled).toBe(true);
    expect(findAllByTag(harness!.dom.container, "FORM")).toHaveLength(0);
  });

  it("shows browser failures and permits a retry without changing subscription", async () => {
    pushMocks.getClientPushState.mockRejectedValueOnce(new Error("Push status offline"));
    await render();
    expect(harness!.dom.container.textContent).toContain("Status check failed: Push status offline");
    expect(findAllByTag(harness!.dom.container, "FORM")).toHaveLength(0);
    await click("Refresh");
    pushMocks.sendCurrentSubscriptionTestNotification.mockRejectedValueOnce(new Error("Test delivery failed"));
    await click("Send test");
    expect(harness!.dom.container.textContent).toContain("Test delivery failed");
    expect(pushMocks.enablePushNotifications).not.toHaveBeenCalled();
  });
});

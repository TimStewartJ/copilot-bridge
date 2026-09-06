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

  it("distinguishes saved state, authorized Focus policy, and browser subscription", async () => {
    await render();

    expect(harness!.dom.container.textContent).toContain("Routine completions stay in their task and do not interrupt you.");
    expect(harness!.dom.container.textContent).toContain("Session notifications: needs-input alerts only.");
    expect(harness!.dom.container.textContent).toContain("Persistence is not permission to interrupt.");
    expect(harness!.dom.container.textContent).toContain("Changing policy does not subscribe or unsubscribe this browser.");
    expect(harness!.dom.container.textContent).toContain("not an unconditional bypass");
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
      expect(getReactProps(button(label))!.className).toContain("min-h-11");
    }
  });

  it("shows settings query errors with retry while browser push remains usable", async () => {
    settingsMocks.useSettingsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Policy service unavailable"),
      isFetching: false,
      refetch: settingsMocks.refetch,
    });
    await render();

    expect(harness!.dom.container.textContent).toContain("Could not load Focus delivery policy: Policy service unavailable");
    expect(findAllByTag(harness!.dom.container, "INPUT")).toHaveLength(0);
    expect(getReactProps(button("Send test"))!.disabled).toBe(false);
    await click("Retry policy loading");
    expect(settingsMocks.refetch).toHaveBeenCalledOnce();
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
    expect(findAllByTag(harness!.dom.container, "FORM")).toHaveLength(1);
    expect(getReactProps(findAllByTag(harness!.dom.container, "FIELDSET")[0])!.disabled).toBe(false);
  });

  it("preserves dirty policy edits during browser push refreshes", async () => {
    await render();
    const timezone = findAllByTag(harness!.dom.container, "INPUT")
      .find((node) => getReactProps(node)?.name === "timezone");
    await harness!.act(async () => {
      getReactProps(timezone)!.onChange({ target: { value: "Europe/Paris" } });
    });
    await click("Refresh");
    await click("Send test");
    expect(getReactProps(timezone)!.value).toBe("Europe/Paris");
    expect(harness!.dom.container.textContent).toContain("Unsaved policy changes");
    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("keeps browser controls usable during policy saves and failures without changing subscription", async () => {
    let rejectSave!: (error: Error) => void;
    settingsMocks.mutateAsync.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject; }));
    await render();
    const timezone = findAllByTag(harness!.dom.container, "INPUT")
      .find((node) => getReactProps(node)?.name === "timezone");
    await harness!.act(async () => {
      getReactProps(timezone)!.onChange({ target: { value: "Europe/Paris" } });
    });
    await harness!.act(async () => {
      getReactProps(findAllByTag(harness!.dom.container, "FORM")[0])!.onSubmit({ preventDefault() {} });
    });

    expect(getReactProps(button("Send test"))!.disabled).toBe(false);
    expect(getReactProps(button("Enable"))!.disabled).toBe(false);
    expect(getReactProps(button("Disable"))!.disabled).toBe(false);
    expect(pushMocks.enablePushNotifications).not.toHaveBeenCalled();
    expect(pushMocks.disablePushNotifications).not.toHaveBeenCalled();
    await click("Send test");
    await harness!.act(async () => { rejectSave(new Error("Save unavailable")); });
    expect(harness!.dom.container.textContent).toContain("Could not save Focus delivery policy: Save unavailable");
    await click("Send test");
    expect(pushMocks.sendCurrentSubscriptionTestNotification).toHaveBeenCalledTimes(2);
    expect(pushMocks.enablePushNotifications).not.toHaveBeenCalled();
    expect(pushMocks.disablePushNotifications).not.toHaveBeenCalled();
  });

  it("shows browser failures without hiding the policy form", async () => {
    pushMocks.getClientPushState.mockRejectedValueOnce(new Error("Push status offline"));
    await render();
    expect(harness!.dom.container.textContent).toContain("Status check failed: Push status offline");
    expect(findAllByTag(harness!.dom.container, "FORM")).toHaveLength(1);
    await click("Refresh");
    pushMocks.sendCurrentSubscriptionTestNotification.mockRejectedValueOnce(new Error("Test delivery failed"));
    await click("Send test");
    expect(harness!.dom.container.textContent).toContain("Test delivery failed");
    expect(findAllByTag(harness!.dom.container, "FORM")).toHaveLength(1);
  });
});

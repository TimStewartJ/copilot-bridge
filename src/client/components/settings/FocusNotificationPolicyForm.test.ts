import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOCUS_NOTIFICATION_POLICY,
  type FocusNotificationPolicy,
} from "../../../shared/focus-notification-policy.js";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../../test-react-harness";

const settingsMocks = vi.hoisted(() => ({
  useSettingsQuery: vi.fn(),
  mutateAsync: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("../../hooks/queries/useSettings", () => ({
  useSettingsQuery: settingsMocks.useSettingsQuery,
  useSettingsMutation: () => ({ mutateAsync: settingsMocks.mutateAsync }),
}));

import { FocusNotificationPolicyForm } from "./FocusNotificationPolicyForm";

function settings(focusNotifications?: FocusNotificationPolicy | null) {
  return { mcpServers: {}, theme: "dark", focusNotifications };
}

const customPolicy: FocusNotificationPolicy = {
  timezone: "Asia/Tokyo",
  quietHours: { start: "21:30", end: "07:15" },
  reviewTimes: ["10:00", "15:30"],
  coalesceMinutes: 12,
  enableAuthorizedImmediate: true,
  allowGrantQuietHoursOverride: true,
};

describe("FocusNotificationPolicyForm", () => {
  let harness: ReactDomHarness | null = null;
  let query: {
    data: ReturnType<typeof settings> | undefined;
    error: Error | null;
    isFetching: boolean;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    query = { data: settings(), error: null, isFetching: false };
    settingsMocks.useSettingsQuery.mockImplementation(() => ({ ...query, refetch: settingsMocks.refetch }));
    settingsMocks.refetch.mockResolvedValue({});
    settingsMocks.mutateAsync.mockImplementation(async (updates: { focusNotifications: FocusNotificationPolicy }) => {
      query.data = settings(updates.focusNotifications);
      return query.data;
    });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function render() {
    harness ??= await createReactDomHarness();
    await harness.render(createElement(FocusNotificationPolicyForm));
  }

  function input(name: string) {
    const node = findAllByTag(harness!.dom.container, "INPUT")
      .find((candidate) => getReactProps(candidate)?.name === name);
    if (!node) throw new Error(`Input not found: ${name}`);
    return node;
  }

  function inputProps(name: string) {
    return getReactProps(input(name))!;
  }

  function button(text: string) {
    const node = findAllByTag(harness!.dom.container, "BUTTON")
      .find((candidate) => candidate.textContent?.trim() === text);
    if (!node) throw new Error(`Button not found: ${text}`);
    return node;
  }

  async function change(name: string, value: string | boolean) {
    await harness!.act(async () => {
      inputProps(name).onChange({ target: typeof value === "boolean" ? { checked: value } : { value } });
    });
  }

  async function click(text: string) {
    await harness!.act(async () => {
      getReactProps(button(text))!.onClick();
    });
  }

  async function submit() {
    await harness!.act(async () => {
      getReactProps(findAllByTag(harness!.dom.container, "FORM")[0])!.onSubmit({ preventDefault() {} });
    });
  }

  function expectDefaultDraft() {
    expect(inputProps("timezone").value).toBe(DEFAULT_FOCUS_NOTIFICATION_POLICY.timezone);
    expect(inputProps("quietHoursEnabled").checked).toBe(true);
    expect(inputProps("quietStart").value).toBe(DEFAULT_FOCUS_NOTIFICATION_POLICY.quietHours?.start);
    expect(inputProps("quietEnd").value).toBe(DEFAULT_FOCUS_NOTIFICATION_POLICY.quietHours?.end);
    expect(inputProps("reviewTimes").value).toBe(DEFAULT_FOCUS_NOTIFICATION_POLICY.reviewTimes.join(", "));
    expect(inputProps("coalesceMinutes").value).toBe(String(DEFAULT_FOCUS_NOTIFICATION_POLICY.coalesceMinutes));
    expect(inputProps("enableAuthorizedImmediate").checked).toBe(false);
    expect(inputProps("allowGrantQuietHoursOverride").checked).toBe(false);
  }

  it.each([undefined, null])("uses shared defaults for an omitted or null policy (%s)", async (policy) => {
    query.data = settings(policy);
    await render();

    expectDefaultDraft();
    expect(getReactProps(button("Save policy"))!.disabled).toBe(true);
    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not present defaults as loaded settings while the query is unavailable", async () => {
    query.data = undefined;
    query.isFetching = true;
    await render();

    expect(harness!.dom.container.textContent).toContain("Loading Focus delivery policy");
    expect(findAllByTag(harness!.dom.container, "INPUT")).toHaveLength(0);

    query = { data: undefined, error: new Error("Settings are unavailable"), isFetching: false };
    await render();

    expect(harness!.dom.container.textContent).toContain("Settings are unavailable");
    expect(findAllByTag(harness!.dom.container, "INPUT")).toHaveLength(0);
    await click("Retry policy loading");
    expect(settingsMocks.refetch).toHaveBeenCalledOnce();

    query = { data: settings(), error: null, isFetching: false };
    await render();
    expectDefaultDraft();
  });

  it("preserves the complete existing policy when only one field changes", async () => {
    query.data = settings(customPolicy);
    await render();
    await change("timezone", "Europe/Paris");
    await submit();

    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      focusNotifications: { ...customPolicy, timezone: "Europe/Paris" },
    });
    expect(harness!.dom.container.textContent).toContain("Focus delivery policy saved.");
  });

  it("serializes every field and waits for the authoritative, normalized save result", async () => {
    query.data = settings(customPolicy);
    let resolveSave!: (result: ReturnType<typeof settings>) => void;
    settingsMocks.mutateAsync.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    await render();
    await change("timezone", " America/Los_Angeles ");
    await change("quietStart", "23:00");
    await change("quietEnd", "06:30");
    await change("reviewTimes", "17:00,  09:30");
    await change("coalesceMinutes", "0");
    await submit();

    const submitted: FocusNotificationPolicy = {
      timezone: "America/Los_Angeles",
      quietHours: { start: "23:00", end: "06:30" },
      reviewTimes: ["17:00", "09:30"],
      coalesceMinutes: 0,
      enableAuthorizedImmediate: true,
      allowGrantQuietHoursOverride: true,
    };
    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({ focusNotifications: submitted });
    expect(harness!.dom.container.textContent).not.toContain("Focus delivery policy saved.");
    expect(getReactProps(button("Saving policy…"))!.disabled).toBe(true);
    expect(getReactProps(findAllByTag(harness!.dom.container, "FIELDSET")[0])!.disabled).toBe(true);

    await submit();
    expect(settingsMocks.mutateAsync).toHaveBeenCalledOnce();
    await harness!.act(async () => {
      query.data = settings({ ...submitted, reviewTimes: ["09:30", "17:00"] });
      resolveSave(query.data);
    });

    expect(inputProps("timezone").value).toBe("America/Los_Angeles");
    expect(inputProps("reviewTimes").value).toBe("09:30, 17:00");
    expect(getReactProps(button("Save policy"))!.disabled).toBe(true);
    expect(harness!.dom.container.textContent).toContain("Focus delivery policy saved.");
    expect(harness!.dom.container.textContent).not.toContain("Unsaved policy changes");
  });

  it("sends null quiet hours and explicit false booleans without validating disabled clock fields", async () => {
    query.data = settings(customPolicy);
    await render();
    await change("quietStart", "");
    await change("quietHoursEnabled", false);
    await change("enableAuthorizedImmediate", false);
    await change("allowGrantQuietHoursOverride", false);
    expect(inputProps("quietStart").disabled).toBe(true);
    expect(inputProps("quietEnd").disabled).toBe(true);
    await submit();

    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      focusNotifications: {
        ...customPolicy,
        quietHours: null,
        enableAuthorizedImmediate: false,
        allowGrantQuietHoursOverride: false,
      },
    });
    expect(inputProps("quietHoursEnabled").checked).toBe(false);
  });

  it("restores default clock fields when enabling a saved null quiet-hours policy", async () => {
    query.data = settings({ ...customPolicy, quietHours: null, coalesceMinutes: 0 });
    await render();

    expect(inputProps("quietHoursEnabled").checked).toBe(false);
    expect(inputProps("coalesceMinutes").value).toBe("0");
    await change("quietHoursEnabled", true);
    await change("enableAuthorizedImmediate", false);
    await change("allowGrantQuietHoursOverride", false);
    await submit();
    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      focusNotifications: {
        ...customPolicy,
        quietHours: DEFAULT_FOCUS_NOTIFICATION_POLICY.quietHours,
        coalesceMinutes: 0,
        enableAuthorizedImmediate: false,
        allowGrantQuietHoursOverride: false,
      },
    });
  });

  it("serializes enabling both authorization policy switches as true", async () => {
    await render();
    await change("enableAuthorizedImmediate", true);
    await change("allowGrantQuietHoursOverride", true);
    await submit();
    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      focusNotifications: {
        ...DEFAULT_FOCUS_NOTIFICATION_POLICY,
        enableAuthorizedImmediate: true,
        allowGrantQuietHoursOverride: true,
      },
    });
    expect(harness!.dom.container.textContent).toContain("Persistence is not permission to interrupt.");
    expect(harness!.dom.container.textContent).toContain("does not create or broaden a grant");
    expect(harness!.dom.container.textContent).toContain("this policy and a matching active grant both permit it");
    expect(harness!.dom.container.textContent).toContain("not an unconditional bypass");
  });

  it.each([
    { name: "timezone", value: "", error: "valid IANA timezone" },
    { name: "timezone", value: "Mars/Olympus", error: "valid IANA timezone" },
    { name: "timezone", value: "+03:00", error: "valid IANA timezone" },
    { name: "quietStart", value: "", error: "start and end as HH:mm" },
    { name: "quietEnd", value: "25:00", error: "start and end as HH:mm" },
    { name: "quietEnd", value: "22:00", error: "start and end must differ" },
    { name: "reviewTimes", value: "", error: "Enter 1–24 review times" },
    { name: "reviewTimes", value: "9:00", error: "Enter 1–24 review times" },
    { name: "reviewTimes", value: "24:00", error: "Enter 1–24 review times" },
    { name: "reviewTimes", value: "09:60", error: "Enter 1–24 review times" },
    { name: "reviewTimes", value: "09:00,", error: "Enter 1–24 review times" },
    { name: "reviewTimes", value: "09:00, 09:00", error: "Review times must be unique" },
    {
      name: "reviewTimes",
      value: Array.from({ length: 25 }, (_, index) => `00:${String(index).padStart(2, "0")}`).join(", "),
      error: "Enter 1–24 review times",
    },
    { name: "coalesceMinutes", value: "", error: "whole number from 0 to 60" },
    { name: "coalesceMinutes", value: "-1", error: "whole number from 0 to 60" },
    { name: "coalesceMinutes", value: "61", error: "whole number from 0 to 60" },
    { name: "coalesceMinutes", value: "1.5", error: "whole number from 0 to 60" },
  ])("rejects $name=$value with an associated, accessible error", async ({ name, value, error }) => {
    await render();
    await change(name, value);
    await submit();

    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
    expect(harness!.dom.container.textContent).toContain(error);
    expect(inputProps(name)["aria-invalid"]).toBe(true);
    const errorId = (inputProps(name)["aria-describedby"] as string).split(" ").at(-1);
    const errorNode = findAllByTag(harness!.dom.container, "P")
      .find((node) => getReactProps(node)?.id === errorId);
    expect(errorNode?.textContent).toContain(error);
    expect(findAllByTag(harness!.dom.container, "P")
      .some((node) => getReactProps(node)?.role === "alert")).toBe(true);
  });

  it.each([1, 24])("accepts %i unique review times and the maximum coalescing window", async (count) => {
    const reviewTimes = Array.from({ length: count }, (_, index) => `${String(index).padStart(2, "0")}:00`);
    await render();
    await change("reviewTimes", reviewTimes.join(", "));
    await change("coalesceMinutes", "60");
    await submit();

    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, reviewTimes, coalesceMinutes: 60 },
    });
  });

  it("preserves dirty edits during refetches and discards to the latest authoritative policy", async () => {
    await render();
    await change("timezone", "America/Chicago");
    query.data = settings(customPolicy);
    await render();

    expect(inputProps("timezone").value).toBe("America/Chicago");
    expect(inputProps("quietStart").value).toBe(DEFAULT_FOCUS_NOTIFICATION_POLICY.quietHours?.start);
    expect(harness!.dom.container.textContent).toContain("Unsaved policy changes");
    await click("Discard changes");
    expect(inputProps("timezone").value).toBe(customPolicy.timezone);
    expect(inputProps("quietStart").value).toBe(customPolicy.quietHours?.start);
    expect(getReactProps(button("Save policy"))!.disabled).toBe(true);
    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("adopts refetched policy changes when the form is clean", async () => {
    await render();
    query.data = settings(customPolicy);
    await render();
    expect(inputProps("timezone").value).toBe(customPolicy.timezone);
    expect(inputProps("coalesceMinutes").value).toBe(String(customPolicy.coalesceMinutes));
    expect(getReactProps(button("Save policy"))!.disabled).toBe(true);
  });

  it("keeps a dirty draft through a failed background query and exposes retry", async () => {
    await render();
    await change("timezone", "Europe/Paris");
    query.error = new Error("Refresh failed");
    await render();

    expect(inputProps("timezone").value).toBe("Europe/Paris");
    expect(harness!.dom.container.textContent).toContain("Showing the last loaded policy; unsaved edits are preserved.");
    await click("Retry policy loading");
    expect(settingsMocks.refetch).toHaveBeenCalledOnce();
  });

  it("retains the draft after a save failure and allows a successful retry", async () => {
    settingsMocks.mutateAsync.mockRejectedValueOnce(new Error("Settings are read-only"));
    await render();
    await change("coalesceMinutes", "20");
    await submit();

    expect(inputProps("coalesceMinutes").value).toBe("20");
    expect(harness!.dom.container.textContent).toContain("Could not save Focus delivery policy: Settings are read-only");
    expect(harness!.dom.container.textContent).not.toContain("Focus delivery policy saved.");
    expect(getReactProps(button("Save policy"))!.disabled).toBe(false);
    expect(findAllByTag(harness!.dom.container, "P").some((node) =>
      getReactProps(node)?.role === "alert" && node.textContent?.includes("Settings are read-only"))).toBe(true);
    await submit();

    expect(settingsMocks.mutateAsync).toHaveBeenCalledTimes(2);
    expect(harness!.dom.container.textContent).toContain("Focus delivery policy saved.");
    expect(harness!.dom.container.textContent).not.toContain("Settings are read-only");
  });

  it("loads defaults as an unsaved draft and applies them only on save", async () => {
    query.data = settings({ ...customPolicy, quietHours: null });
    await render();
    await click("Use defaults");
    expectDefaultDraft();
    expect(settingsMocks.mutateAsync).not.toHaveBeenCalled();
    expect(harness!.dom.container.textContent).toContain("Unsaved policy changes");
    await submit();
    expect(settingsMocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
      focusNotifications: DEFAULT_FOCUS_NOTIFICATION_POLICY,
    });
  });

  it("provides associated field labels and touch-sized input and action targets", async () => {
    await render();
    const labels = findAllByTag(harness!.dom.container, "LABEL");
    for (const field of findAllByTag(harness!.dom.container, "INPUT")) {
      const props = getReactProps(field)!;
      if (props.type === "checkbox") {
        expect(labels.some((label) => findAllByTag(label, "INPUT").includes(field)
          && getReactProps(label)?.className.includes("min-h-11"))).toBe(true);
        if (props["aria-labelledby"]) {
          const label = findAllByTag(harness!.dom.container, "SPAN")
            .find((node) => getReactProps(node)?.id === props["aria-labelledby"]);
          expect(label?.textContent).toMatch(/^Allow /);
          expect(label?.textContent).not.toContain("grant both permit");
        }
      } else {
        expect(labels.some((label) => getReactProps(label)?.htmlFor === props.id)).toBe(true);
        expect(props.className).toContain("min-h-11");
      }
    }
    for (const action of findAllByTag(harness!.dom.container, "BUTTON")) {
      expect(getReactProps(action)?.className).toContain("min-h-11");
    }
  });
});

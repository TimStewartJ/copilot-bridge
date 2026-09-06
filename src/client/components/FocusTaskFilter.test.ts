import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeFocusFilters, focusTaskChoices } from "../focus-filter-helpers";
import { focusTask } from "../test-focus-fixtures";
import { changeFocusField, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { findAllByTag, getReactProps } from "../test-react-harness";
import FocusTaskFilter from "./FocusTaskFilter";

describe("Human-readable Focus task filters", () => {
  let harness: FocusTestHarness;
  beforeEach(async () => { harness = await createFocusTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  it("displays task titles and state while submitting exact unchanged IDs", async () => {
    const choices = focusTaskChoices([
      focusTask({ id: "live-id", title: "Current work" }),
      focusTask({ id: "archived-id", title: "Old responsibility", status: "archived" }),
      focusTask({ id: "muted-id", title: "Quiet responsibility", muted: true }),
    ], []);
    const onChange = vi.fn();
    await harness.render(createElement(FocusTaskFilter, { label: "Task", value: "live-id", choices, onChange }));
    const options = findAllByTag(harness.dom.container, "OPTION");
    expect(options.map((option) => option.textContent)).toEqual(expect.arrayContaining(["Current work", "Old responsibility (archived)", "Quiet responsibility (muted)"]));
    expect(getReactProps(options.find((option) => option.textContent === "Old responsibility (archived)"))?.value).toBe("archived-id");
    await changeFocusField(harness, "Task", "archived-id");
    expect(onChange).toHaveBeenCalledWith("archived-id");
  });

  it("keeps an off-page targeted ID selected instead of falling back to all task scopes", async () => {
    await harness.render(createElement(FocusTaskFilter, { label: "Task", value: "off-page-id", choices: [], onChange: vi.fn() }));
    const select = findAllByTag(harness.dom.container, "SELECT")[0];
    expect(getReactProps(select)?.value).toBe("off-page-id");
    expect(select.textContent).toContain("Unlisted task (off-page-id)");
    expect(getReactProps(findAllByTag(harness.dom.container, "INPUT")[0])?.value).toBe("off-page-id");
  });

  it("disambiguates same-title tasks without changing identity", async () => {
    const choices = focusTaskChoices([focusTask({ id: "one", title: "Same name" }), focusTask({ id: "two", title: "Same name" })], []);
    await harness.render(createElement(FocusTaskFilter, { label: "Task", value: undefined, choices, onChange: vi.fn() }));
    const options = findAllByTag(harness.dom.container, "OPTION");
    expect(options.map((option) => option.textContent)).toEqual(["All task scopes", "Same name [one]", "Same name [two]"]);
    expect(options.map((option) => getReactProps(option)?.value)).toEqual(["", "one", "two"]);
  });

  it("does not borrow a current task title for a different original task", async () => {
    const contexts = [{ taskId: "current-id", taskTitle: "Current named task", originalTaskId: "original-id", originalTaskTitle: null }];
    const choices = focusTaskChoices([], contexts, true);
    expect(choices).toEqual([]);
    await harness.render(createElement(FocusTaskFilter, { label: "Original task", value: "original-id", choices, onChange: vi.fn() }));
    expect(harness.dom.container.textContent).toContain("Unlisted task (original-id)");
    expect(harness.dom.container.textContent).not.toContain("Current named task");
  });

  it("uses retained names for removed tasks and prefers live names when the same identity is still available", () => {
    const contexts = [{ taskId: null, originalTaskId: "original-id", originalTaskTitle: "Former responsibility", orphanedAt: "2026-09-01T00:00:00Z" }];
    const original = focusTaskChoices([], contexts, true);
    expect(original).toEqual([{ id: "original-id", title: "Former responsibility", hint: "removed" }]);
    const live = focusTaskChoices([focusTask({ id: "original-id", title: "Current name" })], contexts, true);
    expect(live[0].title).toBe("Current name");
    expect(live[0].hint).toBeUndefined();
    expect(describeFocusFilters({ originalTaskId: "original-id", lifecycle: "handed_off", objectType: "decision" }, [], original))
      .toBe("Original task: Former responsibility (removed) · Lifecycle: Handed off · Record type: Decisions");
  });

  it("retains exact-ID entry for tasks not in the loaded labels", async () => {
    const onChange = vi.fn();
    await harness.render(createElement(FocusTaskFilter, { label: "Original task", value: undefined, choices: [], onChange }));
    expect(findAllByTag(harness.dom.container, "SUMMARY")[0].textContent).toBe("Exact original task identifier");
    await changeFocusField(harness, "Original task ID", "unlisted/original");
    expect(onChange).toHaveBeenCalledWith("unlisted/original");
  });
});

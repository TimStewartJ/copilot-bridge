import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusAction } from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import ChecklistItemRow from "./ChecklistItemRow";

describe("Action source relationships across list layouts", () => {
  let harness: FocusTestHarness;
  beforeEach(async () => { harness = await createFocusTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  it.each([false, true])("keeps Global Action sources inspectable when task pills are hidden=%s", async (hideTaskPill) => {
    const onInspectFocusObject = vi.fn();
    await harness.render(createElement(ChecklistItemRow, {
      variant: "dashboard", hideTaskPill, checklistItem: focusAction({ taskId: null, done: true }),
      onUpdate: vi.fn(), onDelete: vi.fn(), onInspectFocusObject,
    }));
    expect(harness.dom.container.textContent).toContain("Source decision: Should we roll back the release?");
    expect(harness.dom.container.textContent).toContain("Handed off (still open)");
    expect(harness.dom.container.textContent).toContain("Action complete; source outcomes are separate");
    await clickFocusButton(harness, "Inspect source");
    expect(onInspectFocusObject).toHaveBeenCalledWith("decision-1");
  });
});

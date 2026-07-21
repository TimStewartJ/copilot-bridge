import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Schedule } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import ScheduleRow from "./ScheduleRow";

function makeSchedule(enabled: boolean): Schedule {
  return {
    id: "schedule-1",
    taskId: "task-1",
    name: "Daily review",
    prompt: "Review the queue",
    type: "cron",
    cron: "0 9 * * *",
    enabled,
    createdAt: "2026-07-21T16:00:00.000Z",
    updatedAt: "2026-07-21T16:00:00.000Z",
    runCount: 0,
  };
}

async function renderScheduleRow(schedule: Schedule) {
  const harness = await createReactDomHarness();
  await harness.render(createElement(ScheduleRow, {
    schedule,
    onOpen: vi.fn(),
    onToggle: vi.fn(),
  }));
  return harness;
}

function findToggleButton(root: any, title: "Pause" | "Resume") {
  const button = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.title === title,
  );
  if (!button) throw new Error(`${title} button was not rendered`);
  return button;
}

describe("ScheduleRow", () => {
  it("renders a Pause icon for active schedules", async () => {
    const harness = await renderScheduleRow(makeSchedule(true));
    const button = findToggleButton(harness.dom.container, "Pause");
    const [icon] = findAllByTag(button, "SVG");

    expect(icon?.getAttribute("class")).toContain("lucide-pause");
  });

  it("renders a Play icon for paused schedules", async () => {
    const harness = await renderScheduleRow(makeSchedule(false));
    const button = findToggleButton(harness.dom.container, "Resume");
    const [icon] = findAllByTag(button, "SVG");

    expect(icon?.getAttribute("class")).toContain("lucide-play");
  });
});

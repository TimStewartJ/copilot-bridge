import { describe, expect, it } from "vitest";
import { getTaskKindLabel, getTaskKindUpdate, isOngoingTask } from "./task-kind";

describe("getTaskKindUpdate", () => {
  it("clears doneWhen when switching to ongoing", () => {
    expect(
      getTaskKindUpdate({ kind: "task", status: "active", doneWhen: "Ship it" }, "ongoing"),
    ).toEqual({
      kind: "ongoing",
      doneWhen: null,
    });
  });

  it("reopens done tasks when switching to ongoing", () => {
    expect(
      getTaskKindUpdate({ kind: "task", status: "done", doneWhen: "Merged" }, "ongoing"),
    ).toEqual({
      kind: "ongoing",
      status: "active",
      doneWhen: null,
    });
  });

  it("returns null when nothing changes", () => {
    expect(
      getTaskKindUpdate({ kind: "ongoing", status: "active", doneWhen: undefined }, "ongoing"),
    ).toBeNull();
  });

  it("switches ongoing items back to task without changing status", () => {
    expect(
      getTaskKindUpdate({ kind: "ongoing", status: "active", doneWhen: undefined }, "task"),
    ).toEqual({
      kind: "task",
    });
  });
});

describe("task kind helpers", () => {
  it("labels task kinds for the UI", () => {
    expect(getTaskKindLabel("task")).toBe("Task");
    expect(getTaskKindLabel("ongoing")).toBe("Ongoing");
  });

  it("detects ongoing tasks", () => {
    expect(isOngoingTask({ kind: "ongoing" })).toBe(true);
    expect(isOngoingTask({ kind: "task" })).toBe(false);
  });
});

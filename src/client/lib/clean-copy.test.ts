import { describe, expect, it, vi } from "vitest";
import { handleCleanCopy } from "./clean-copy";

function copyEvent(target: object, defaultPrevented = false) {
  const data = new Map<string, string>();
  return {
    data,
    event: {
      target: target as EventTarget,
      defaultPrevented,
      preventDefault: vi.fn(),
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) } as unknown as DataTransfer,
    },
  };
}

const selection = (text: string) => () => ({ toString: () => text, rangeCount: 0, getRangeAt: () => { throw new Error("no range"); } });

describe("handleCleanCopy", () => {
  it("replaces the browser copy of a rendered selection with its text", () => {
    const { data, event } = copyEvent({ tagName: "P" });
    handleCleanCopy(event, selection("Heading\n\nSome **bold** text"));
    expect([...data]).toEqual([["text/plain", "Heading\n\nSome **bold** text"]]);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it.each([
    ["a textarea", { tagName: "TEXTAREA" }, false],
    ["an editable element", { tagName: "DIV", isContentEditable: true }, false],
    ["a copy another handler already took", { tagName: "P" }, true],
  ])("leaves %s to the browser", (_label, target, prevented) => {
    const { data, event } = copyEvent(target, prevented);
    handleCleanCopy(event, selection("text"));
    expect(data.size).toBe(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { hasPageAttention } from "./usePageAttention.js";

describe("hasPageAttention", () => {
  it("requires both visible and focused page state", () => {
    const cases: [NonNullable<Parameters<typeof hasPageAttention>[0]>, boolean][] = [
      [{ visibilityState: "visible", hasFocus: () => true }, true],
      [{ visibilityState: "hidden", hasFocus: () => true }, false],
      [{ visibilityState: "visible", hasFocus: () => false }, false],
    ];
    for (const [doc, expected] of cases) {
      expect(hasPageAttention(doc), `${doc.visibilityState}/${doc.hasFocus()}`).toBe(expected);
    }
  });
});

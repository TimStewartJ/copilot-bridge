import { describe, expect, it } from "vitest";
import { resolveSearchDateRange, type SearchWhen } from "./search-dates";

const local = (...parts: [number, number, number, number?, number?]) => new Date(...parts as [number, number, number, number, number]).toISOString();

describe("resolveSearchDateRange", () => {
  const now = new Date(2026, 2, 31, 15, 30);
  it.each<[string, { when: SearchWhen; after?: string; before?: string }, Date, { after?: string; before?: string }]>([
    ["any time", { when: "any", after: "2026-01-01" }, now, {}],
    ["today from local midnight", { when: "day" }, now, { after: local(2026, 2, 31) }],
    ["a rolling week", { when: "week" }, now, { after: new Date(now.getTime() - 7 * 86_400_000).toISOString() }],
    ["a month back from the 31st", { when: "month" }, now, { after: local(2026, 1, 28, 15, 30) }],
    ["a year back from 29 February", { when: "year" }, new Date(2028, 1, 29, 9), { after: local(2027, 1, 28, 9) }],
    ["whole local days for a custom range", { when: "custom", after: "2026-10-01", before: "2026-10-31" }, now,
      { after: local(2026, 9, 1), before: local(2026, 10, 1) }],
    ["a backwards custom range", { when: "custom", after: "2026-10-31", before: "2026-10-01" }, now,
      { after: local(2026, 9, 1), before: local(2026, 10, 1) }],
    ["one open end", { when: "custom", before: "2026-10-31" }, now, { before: local(2026, 10, 1) }],
    ["impossible dates", { when: "custom", after: "2026-02-30", before: "soon" }, now, {}],
  ])("resolves %s", (_name, choice, at, expected) => {
    expect(resolveSearchDateRange(choice, at)).toEqual(expected);
  });
});

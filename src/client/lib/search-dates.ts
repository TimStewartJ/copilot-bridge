/** A search's date choice: a rolling period up to now, or a custom range of whole local days. */
export type SearchWhen = "any" | "day" | "week" | "month" | "year" | "custom";

export interface SearchDateRange {
  /** Inclusive ISO instant. */
  after?: string;
  /** Exclusive ISO instant. */
  before?: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseSearchWhen(value: string | null | undefined): SearchWhen {
  return value === "day" || value === "week" || value === "month" || value === "year" || value === "custom"
    ? value
    : "any";
}

/** Local midnight at the start of a `YYYY-MM-DD` date, moved by `dayOffset` days. */
function localDayStart(value: string | null | undefined, dayOffset = 0): Date | undefined {
  const match = DATE_PATTERN.exec(value ?? "");
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return undefined;
  // Built afresh: moving a date whose midnight a clock change skipped would keep its 01:00.
  return new Date(year, month, day + dayOffset);
}

/** The same time `months` months earlier, kept inside the target month (31 March less one month is 28 or 29 February). */
function monthsBefore(now: Date, months: number): Date {
  const date = new Date(now);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date;
}

/** Turns the URL's date choice into the instants the search API takes. */
export function resolveSearchDateRange(
  choice: { when: SearchWhen; after?: string | null; before?: string | null },
  now = new Date(),
): SearchDateRange {
  switch (choice.when) {
    case "day":
      return { after: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() };
    case "week":
      return { after: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString() };
    case "month":
      return { after: monthsBefore(now, 1).toISOString() };
    case "year":
      return { after: monthsBefore(now, 12).toISOString() };
    case "custom": {
      // A range entered backwards still means the days between the two dates.
      const [first, last] = (choice.after && choice.before && choice.after > choice.before)
        ? [choice.before, choice.after]
        : [choice.after, choice.before];
      const after = localDayStart(first);
      const before = localDayStart(last, 1);
      return {
        ...(after ? { after: after.toISOString() } : {}),
        ...(before ? { before: before.toISOString() } : {}),
      };
    }
    default:
      return {};
  }
}

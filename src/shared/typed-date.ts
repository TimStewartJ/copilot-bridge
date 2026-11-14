// Dates typed as people say them: "fri", "tmrw 9am", "in 3 days", "Nov 15 at 3:30pm". Pure and
// local-time: every date is read in the zone of `now` (the browser's, in the client).

export interface TypedTime { hour: number; minute: number }

export interface TypedWhen {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Present when a time was said. */
  time?: TypedTime;
}

export interface ExtractedWhen {
  /** The text with the date phrase removed. */
  rest: string;
  when: TypedWhen;
  /** The words that were read as the date, as typed. */
  phrase: string;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const PART_OF_DAY: Record<string, number> = { morning: 9, afternoon: 14, evening: 19, tonight: 19, noon: 12, midnight: 0, eod: 17 };
const FILLERS = new Set(["on", "at", "by", "due", "@"]);

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function validDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** A month and day without a year: this year, or next year once it has passed. */
function monthDay(month: number, day: number, year: number | undefined, now: Date): Date | null {
  if (year !== undefined) return validDate(year < 100 ? 2000 + year : year, month, day);
  const today = startOfDay(now);
  const thisYear = validDate(now.getFullYear(), month, day);
  if (thisYear && thisYear.getTime() >= today.getTime()) return thisYear;
  return validDate(now.getFullYear() + 1, month, day);
}

interface State { date?: Date; time?: TypedTime; partHour?: number; relativeMs?: number }

/** Reads one token run at `i`; returns how many tokens it used, or 0. */
function readToken(tokens: string[], i: number, now: Date, state: State): number {
  const t = tokens[i];
  const next = tokens[i + 1];
  const today = startOfDay(now);
  const setDate = (date: Date | null, used: number) => {
    if (!date || state.date) return 0;
    state.date = date;
    return used;
  };
  const setTime = (time: TypedTime | null, used: number) => {
    if (!time || state.time) return 0;
    state.time = time;
    return used;
  };

  if (t === "today") return setDate(today, 1);
  if (t === "tonight") {
    if (setDate(today, 1) === 0) return 0;
    state.partHour = 19;
    return 1;
  }
  if (t === "tomorrow" || t === "tmrw" || t === "tmr" || t === "tom") return setDate(addDays(today, 1), 1);
  if (t === "yesterday") return 0;

  if ((t === "next" || t === "this") && next === "week") {
    // Next week starts on its Monday.
    const daysToMonday = ((8 - today.getDay()) % 7) || 7;
    return setDate(addDays(today, t === "next" ? daysToMonday : 0), 2);
  }
  if ((t === "next" || t === "this") && (next === "weekend")) {
    const toSat = (6 - today.getDay() + 7) % 7;
    return setDate(addDays(today, t === "next" && toSat < 6 ? toSat + 7 : toSat), 2);
  }
  if (t === "weekend") return setDate(addDays(today, (6 - today.getDay() + 7) % 7), 1);
  if ((t === "next" || t === "this") && next !== undefined && next in WEEKDAYS) {
    const target = WEEKDAYS[next];
    if (t === "this") return setDate(addDays(today, (target - today.getDay() + 7) % 7), 2);
    // "next fri": that day in the coming week, counted from next Monday.
    const daysToMonday = ((8 - today.getDay()) % 7) || 7;
    const monday = addDays(today, daysToMonday);
    return setDate(addDays(monday, (target - 1 + 7) % 7), 2);
  }
  if (t in WEEKDAYS) return setDate(addDays(today, (WEEKDAYS[t] - today.getDay() + 7) % 7), 1);

  // in 3 days / in 2 weeks / in 1 month / in 2 hours / in 30 min
  if (t === "in" && next !== undefined) {
    const amount = next === "a" || next === "an" ? 1 : Number(next);
    const unit = tokens[i + 2];
    if (Number.isInteger(amount) && amount > 0 && amount < 1000 && unit) {
      if (/^days?$/.test(unit)) return setDate(addDays(today, amount), 3);
      // agent-text-audit: user-input (a date the user types)
      if (/^(weeks?|wks?)$/.test(unit)) return setDate(addDays(today, amount * 7), 3);
      if (/^months?$/.test(unit)) {
        const target = new Date(today.getFullYear(), today.getMonth() + amount, 1);
        const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
        target.setDate(Math.min(today.getDate(), lastDay));
        return setDate(target, 3);
      }
      // agent-text-audit: user-input (a date the user types)
      if (/^(hours?|hrs?|h)$/.test(unit) || /^(minutes?|mins?|m)$/.test(unit)) {
        if (state.date || state.time || state.relativeMs !== undefined) return 0;
        // agent-text-audit: user-input (a date the user types)
        state.relativeMs = amount * (/^(hours?|hrs?|h)$/.test(unit) ? 3_600_000 : 60_000);
        return 3;
      }
    }
  }

  // ISO 2026-11-15
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return setDate(validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])), 1);
  // 11/15 or 11/15/2027 (month first)
  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t);
  if (slash) return setDate(monthDay(Number(slash[1]), Number(slash[2]), slash[3] ? Number(slash[3]) : undefined, now), 1);
  // Nov 15, November 15th, Nov 15 2027
  if (t in MONTHS && next !== undefined) {
    const day = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(next);
    if (day) {
      const year = tokens[i + 2] && /^\d{4}$/.test(tokens[i + 2]) ? Number(tokens[i + 2]) : undefined;
      return setDate(monthDay(MONTHS[t], Number(day[1]), year, now), year === undefined ? 2 : 3);
    }
  }
  // 15 Nov, 15th November
  const leadingDay = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (leadingDay && next !== undefined && next in MONTHS) {
    const year = tokens[i + 2] && /^\d{4}$/.test(tokens[i + 2]) ? Number(tokens[i + 2]) : undefined;
    return setDate(monthDay(MONTHS[next], Number(leadingDay[1]), year, now), year === undefined ? 2 : 3);
  }

  // Times: 3pm, 3 pm, 3:30pm, 15:30, noon, morning
  if (t in PART_OF_DAY && t !== "tonight") {
    if (state.partHour !== undefined || state.time) return 0;
    if (t === "noon" || t === "midnight" || t === "eod") return setTime({ hour: PART_OF_DAY[t], minute: 0 }, 1);
    state.partHour = PART_OF_DAY[t];
    return 1;
  }
  const clock = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    let suffix = clock[3];
    let used = 1;
    if (!suffix && next && /^(am|pm|a\.m\.|p\.m\.)$/.test(next)) { suffix = next; used = 2; }
    if (minute > 59) return 0;
    if (suffix) {
      if (hour < 1 || hour > 12) return 0;
      const pm = suffix.startsWith("p");
      hour = (hour % 12) + (pm ? 12 : 0);
    } else if (clock[2] === undefined) {
      // A bare number is a time only after "at" ("at 3"), read as the next 3 o'clock in daytime hours.
      if (tokens[i - 1] !== "at" || hour > 23) return 0;
      if (hour >= 1 && hour <= 7) hour += 12;
    } else if (hour > 23) {
      return 0;
    }
    return setTime({ hour, minute }, used);
  }
  return 0;
}

/** Reads a whole phrase as a date, or returns null when any word is not part of one. */
export function parseWhen(text: string, now: Date = new Date()): TypedWhen | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const state: State = {};
  let i = 0;
  let meaningful = 0;
  while (i < tokens.length) {
    if (FILLERS.has(tokens[i])) { i += 1; continue; }
    const used = readToken(tokens, i, now, state);
    if (!used) return null;
    meaningful += 1;
    i += used;
  }
  if (!meaningful) return null;
  if (state.relativeMs !== undefined) {
    const at = new Date(now.getTime() + state.relativeMs);
    return { date: toDateKey(at), time: { hour: at.getHours(), minute: at.getMinutes() } };
  }
  const time = state.time ?? (state.partHour !== undefined ? { hour: state.partHour, minute: 0 } : undefined);
  let date = state.date;
  if (!date) {
    if (!time) return null;
    // A time alone is today, or tomorrow once it has passed.
    const today = startOfDay(now);
    const passed = time.hour * 60 + time.minute <= now.getHours() * 60 + now.getMinutes();
    date = passed ? addDays(today, 1) : today;
  }
  return time ? { date: toDateKey(date), time } : { date: toDateKey(date) };
}

/**
 * Finds a date phrase at the end of a line ("Call the bank fri 3pm") and returns the rest. The
 * longest trailing run of words that reads as a date wins; at least one other word must remain.
 */
export function extractWhen(text: string, now: Date = new Date()): ExtractedWhen | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let take = Math.min(6, words.length - 1); take >= 1; take -= 1) {
    const phraseWords = words.slice(words.length - take);
    const when = parseWhen(phraseWords.join(" "), now);
    if (!when) continue;
    // A lone bare number or filler is not a date to pull off the end of a title.
    if (phraseWords.every((word) => FILLERS.has(word.toLowerCase()))) continue;
    let restWords = words.slice(0, words.length - take);
    while (restWords.length > 1 && FILLERS.has(restWords[restWords.length - 1].toLowerCase())) restWords = restWords.slice(0, -1);
    const rest = restWords.join(" ").replace(/[\s,;:–-]+$/, "");
    if (!rest) continue;
    return { rest, when, phrase: phraseWords.join(" ") };
  }
  return null;
}

/** The local moment a typed date names, with `defaultHour` when no time was said. */
export function whenToDate(when: TypedWhen, defaultHour = 9): Date {
  const [y, m, d] = when.date.split("-").map(Number);
  return new Date(y, m - 1, d, when.time?.hour ?? defaultHour, when.time?.minute ?? 0, 0, 0);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/,/g, " ")
    // The value a date-time field holds: 2026-11-03T09:00
    .replace(/(\d{4}-\d{2}-\d{2})t(\d{1,2}:\d{2})/g, "$1 $2")
    .replace(/(\d)(am|pm|a|p)\b/g, "$1$2")
    .split(/\s+/)
    .map((token) => token.replace(/\.$/, ""))
    .filter(Boolean);
}

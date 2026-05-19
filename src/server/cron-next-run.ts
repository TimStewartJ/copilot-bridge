const NEXT_RUN_LOOKAHEAD_DAYS = 8 * 366;
const WEEKDAY_BY_SHORT_NAME: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const MONTH_NAME_TO_NUMBER: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const WEEKDAY_NAME_TO_NUMBER: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

interface CronField {
  values: number[];
}

interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const timezoneDatePartFormatters = new Map<string, Intl.DateTimeFormat>();

export function computeNextRunAt(cronExpr: string, timezone?: string, after?: Date): string | undefined {
  try {
    const parsed = parseCronExpression(cronExpr);
    if (!parsed) return undefined;

    const start = after ?? new Date();
    const startTime = start.getTime();
    const startLocal = getDatePartsInTz(start, timezone);
    const firstLocalDay = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day);

    for (let dayOffset = 0; dayOffset < NEXT_RUN_LOOKAHEAD_DAYS; dayOffset += 1) {
      const localDay = new Date(firstLocalDay);
      localDay.setUTCDate(localDay.getUTCDate() + dayOffset);
      const year = localDay.getUTCFullYear();
      const month = localDay.getUTCMonth() + 1;
      const day = localDay.getUTCDate();
      const weekday = localDay.getUTCDay();
      if (
        !fieldIncludes(parsed.month, month)
        || !fieldIncludes(parsed.day, day)
        || !fieldIncludes(parsed.weekday, weekday)
      ) {
        continue;
      }

      for (const hour of parsed.hour.values) {
        for (const minute of parsed.minute.values) {
          const candidate = localTimeToDate({ year, month, day, hour, minute, weekday }, timezone);
          if (!candidate || candidate.getTime() <= startTime) continue;
          return candidate.toISOString();
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function matchesCron(cronExpr: string, date: Date, timezone?: string): boolean {
  try {
    const parsed = parseCronExpression(cronExpr);
    if (!parsed) return false;

    const { minute, hour, day, month, weekday } = getDatePartsInTz(date, timezone);
    return fieldIncludes(parsed.minute, minute)
      && fieldIncludes(parsed.hour, hour)
      && fieldIncludes(parsed.day, day)
      && fieldIncludes(parsed.month, month)
      && fieldIncludes(parsed.weekday, weekday);
  } catch {
    return false;
  }
}

export function matchesField(value: number, field: string): boolean {
  const parsed = parseCronField(field, 0, Math.max(59, value), undefined);
  return parsed ? fieldIncludes(parsed, value) : false;
}

function parseCronExpression(cronExpr: string): ParsedCronExpression | undefined {
  const rawFields = cronExpr.trim().split(/\s+/);
  const fields = rawFields.length === 6 && rawFields[0] === "0"
    ? rawFields.slice(1)
    : rawFields;
  if (fields.length !== 5) return undefined;

  const minute = parseCronField(fields[0], 0, 59, undefined);
  const hour = parseCronField(fields[1], 0, 23, undefined);
  const day = parseCronField(fields[2], 1, 31, undefined);
  const month = parseCronField(fields[3], 1, 12, MONTH_NAME_TO_NUMBER);
  // Keep legacy scheduler semantics: day-of-month and weekday are both required
  // when both fields are constrained, unlike Vixie cron's OR behavior.
  const weekday = parseCronField(fields[4], 0, 7, WEEKDAY_NAME_TO_NUMBER, (value) => value === 7 ? 0 : value);
  if (!minute || !hour || !day || !month || !weekday) return undefined;
  return { minute, hour, day, month, weekday };
}

function parseCronField(
  field: string | undefined,
  min: number,
  max: number,
  namedValues?: Record<string, number>,
  normalizeValue: (value: number) => number = (value) => value,
): CronField | undefined {
  if (!field || field.trim().length === 0) return undefined;
  const values = new Set<number>();
  const normalizedField = normalizeCronFieldNames(field.toLowerCase(), namedValues);
  for (const part of normalizedField.split(",")) {
    if (part.length === 0) return undefined;
    const parsedPart = parseCronFieldPart(part, min, max, normalizeValue);
    if (!parsedPart) return undefined;
    for (const value of parsedPart) values.add(value);
  }
  if (values.size === 0) return undefined;
  return { values: [...values].sort((a, b) => a - b) };
}

function normalizeCronFieldNames(field: string, namedValues?: Record<string, number>): string {
  if (!namedValues) return field;
  return field.replace(/[a-z]+/g, (token) => String(namedValues[token] ?? token));
}

function parseCronFieldPart(
  part: string,
  min: number,
  max: number,
  normalizeValue: (value: number) => number,
): number[] | undefined {
  const [base, stepRaw, extra] = part.split("/");
  if (extra !== undefined) return undefined;
  const step = stepRaw === undefined ? 1 : parseCronNumber(stepRaw);
  if (!step || step < 1) return undefined;

  let start: number;
  let end: number;
  if (base === "*") {
    start = min;
    end = max;
  } else if (base?.includes("-")) {
    const [startRaw, endRaw, rangeExtra] = base.split("-");
    if (rangeExtra !== undefined) return undefined;
    const parsedStart = parseCronNumber(startRaw);
    const parsedEnd = parseCronNumber(endRaw);
    if (parsedStart === undefined || parsedEnd === undefined) return undefined;
    start = parsedStart;
    end = parsedEnd;
  } else {
    const parsedStart = parseCronNumber(base);
    if (parsedStart === undefined) return undefined;
    start = parsedStart;
    end = stepRaw === undefined ? parsedStart : max;
  }

  if (start < min || start > max || end < min || end > max || start > end) return undefined;

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(normalizeValue(value));
  }
  return values;
}

function parseCronNumber(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fieldIncludes(field: CronField, value: number): boolean {
  return field.values.includes(value);
}

function getDatePartsInTz(date: Date, timezone?: string): LocalDateParts {
  if (!timezone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  const fmt = getTimezoneDatePartFormatter(timezone);
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value.slice(0, 3);
  const weekday = weekdayName ? WEEKDAY_BY_SHORT_NAME[weekdayName] ?? 0 : 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    weekday,
  };
}

function getTimezoneDatePartFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = timezoneDatePartFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    timezoneDatePartFormatters.set(timezone, formatter);
  }
  return formatter;
}

function localTimeToDate(parts: LocalDateParts, timezone?: string): Date | undefined {
  if (!timezone) {
    const candidate = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    return localDatePartsEqual(getDatePartsInTz(candidate), parts) ? candidate : undefined;
  }

  const targetTime = localPartsToUtcMs(parts);
  let utcTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = getDatePartsInTz(new Date(utcTime), timezone);
    const delta = localPartsToUtcMs(actual) - targetTime;
    if (delta === 0) break;
    utcTime -= delta;
  }

  const candidate = new Date(utcTime);
  return localDatePartsEqual(getDatePartsInTz(candidate, timezone), parts) ? candidate : undefined;
}

function localPartsToUtcMs(parts: Pick<LocalDateParts, "year" | "month" | "day" | "hour" | "minute">): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

function localDatePartsEqual(actual: LocalDateParts, expected: LocalDateParts): boolean {
  return actual.year === expected.year
    && actual.month === expected.month
    && actual.day === expected.day
    && actual.hour === expected.hour
    && actual.minute === expected.minute;
}

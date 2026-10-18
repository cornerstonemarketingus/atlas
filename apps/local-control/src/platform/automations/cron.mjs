/**
 * Five-field cron (minute hour day-of-month month day-of-week) in the
 * machine's local time, the way people write it:
 *
 *   *  5  1,15  * /2  1-5  and names (jan-dec, sun-sat); 0 and 7 are Sunday.
 *
 * As in Vixie cron, when both day-of-month and day-of-week are restricted a
 * day matches if either does. `nextRun` searches minute by minute over a
 * bounded window (366 days), skipping whole days and hours that cannot match,
 * so an impossible expression ("0 0 31 2 *") returns null instead of looping.
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day of week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];
const ALIASES = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };
const SEARCH_LIMIT_MS = 366 * 24 * 60 * 60 * 1000;

export class CronError extends Error {
  constructor(message) {
    super(message);
    this.name = "CronError";
    this.code = "INVALID_SCHEDULE";
  }
}

/** Parses an expression into sets of allowed values; throws CronError with the field at fault. */
export function parseCron(expression) {
  const text = ALIASES[String(expression ?? "").trim().toLowerCase()] ?? String(expression ?? "").trim();
  const parts = text.split(/\s+/u);
  if (parts.length !== 5) throw new CronError("A schedule has five parts: minute hour day-of-month month day-of-week (for example \"0 9 * * 1-5\").");
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]));
  if (weekdays.has(7)) { weekdays.delete(7); weekdays.add(0); }
  return {
    minutes, hours, days, months, weekdays,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
    source: text,
  };
}

function parseField(part, field) {
  const values = new Set();
  for (const item of part.split(",")) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/iu.exec(item);
    if (!match) throw new CronError(`"${item}" is not a valid ${field.name}.`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`The step in "${item}" must be a positive number.`);
    let low = field.min;
    let high = field.name === "day of week" ? 6 : field.max;
    if (range !== "*") {
      const [from, to = from] = range.split("-");
      low = value(from, field, item);
      high = range.includes("-") ? value(to, field, item) : (stepText === undefined ? low : (field.name === "day of week" ? 6 : field.max));
      if (low > high) throw new CronError(`"${item}" runs backwards; write the smaller ${field.name} first.`);
    }
    for (let current = low; current <= high; current += step) values.add(current);
  }
  return values;
}

function value(token, field, item) {
  const lower = token.toLowerCase();
  const named = field.names?.indexOf(lower) ?? -1;
  const number = named >= 0 ? named + (field.name === "month" ? 1 : 0) : /^\d+$/u.test(lower) ? Number(lower) : NaN;
  if (!Number.isInteger(number) || number < field.min || number > field.max) {
    throw new CronError(`"${item}" is outside ${field.name} (${field.min}-${field.max}).`);
  }
  return number;
}

function dayMatches(schedule, date) {
  const dom = schedule.days.has(date.getDate());
  const dow = schedule.weekdays.has(date.getDay());
  if (schedule.anyDay && schedule.anyWeekday) return true;
  if (schedule.anyDay) return dow;
  if (schedule.anyWeekday) return dom;
  return dom || dow;
}

/** The first run strictly after `after` (a Date), in local time, or null within a year. */
export function nextRun(schedule, after) {
  const parsed = typeof schedule === "string" ? parseCron(schedule) : schedule;
  const limit = after.getTime() + SEARCH_LIMIT_MS;
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  while (cursor.getTime() <= limit) {
    if (!parsed.months.has(cursor.getMonth() + 1) || !dayMatches(parsed, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (parsed.minutes.has(cursor.getMinutes())) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// US equity market calendar helpers. All logic works on America/New_York
// wall time derived via Intl, so DST is handled by the runtime.

export interface ETParts {
  date: string; // YYYY-MM-DD in ET
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun ... 6=Sat
  minutesOfDay: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

export function etParts(d: Date = new Date()): ETParts {
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24; // Intl can return "24" for midnight
  const minute = Number(get("minute"));
  const weekday = WEEKDAYS[get("weekday")] ?? 0;
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    minutesOfDay: hour * 60 + minute,
  };
}

// NYSE/NASDAQ full-day holidays. Extend this list each year.
export const MARKET_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

// Early close days (13:00 ET close).
export const EARLY_CLOSE_DAYS = new Set<string>([
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
]);

export const MARKET_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
export const MARKET_CLOSE_MIN = 16 * 60; // 16:00 ET
export const EARLY_CLOSE_MIN = 13 * 60; // 13:00 ET

export function isTradingDay(p: ETParts): boolean {
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !MARKET_HOLIDAYS.has(p.date);
}

export function marketCloseMinutes(p: ETParts): number {
  return EARLY_CLOSE_DAYS.has(p.date) ? EARLY_CLOSE_MIN : MARKET_CLOSE_MIN;
}

export function isMarketOpen(d: Date = new Date()): boolean {
  const p = etParts(d);
  if (!isTradingDay(p)) return false;
  return p.minutesOfDay >= MARKET_OPEN_MIN && p.minutesOfDay < marketCloseMinutes(p);
}

export function minutesSinceOpen(d: Date = new Date()): number {
  return etParts(d).minutesOfDay - MARKET_OPEN_MIN;
}

// "HH:MM" ET, e.g. "13:45"
export function parseTimeAt(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function todayET(d: Date = new Date()): string {
  return etParts(d).date;
}

// Most recent Friday date string (ET) for weekly review bookkeeping.
export function weekStartET(d: Date = new Date()): string {
  const p = etParts(d);
  const date = new Date(d);
  const daysBack = (p.weekday + 6) % 7; // days since Monday
  date.setUTCDate(date.getUTCDate() - daysBack);
  return etParts(date).date;
}

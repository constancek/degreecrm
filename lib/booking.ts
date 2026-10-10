// Arrival windows and bookable days (client-safe: no server imports).

export const WINDOWS = [
  { id: "09-12", label: "9 am – 12 pm", startHour: 9, endHour: 12 },
  { id: "12-15", label: "12 pm – 3 pm", startHour: 12, endHour: 15 },
  { id: "15-18", label: "3 pm – 6 pm", startHour: 15, endHour: 18 },
  { id: "09-18", label: "All day (9 am – 6 pm)", startHour: 9, endHour: 18 },
] as const;

export type WindowId = (typeof WINDOWS)[number]["id"];

export function windowLabel(id: string | null | undefined): string {
  return WINDOWS.find((w) => w.id === id)?.label ?? id ?? "";
}

const TZ = "America/New_York";

function ymdEastern(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function addDays(ymd: string, days: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const BOOKING_DAYS_AHEAD = 21;

/** Days a customer can ask for: tomorrow through three weeks out, Monday–Saturday. */
export function bookableDates(now = new Date()): { ymd: string; label: string }[] {
  const today = ymdEastern(now);
  const out: { ymd: string; label: string }[] = [];
  for (let i = 1; i <= BOOKING_DAYS_AHEAD; i++) {
    const ymd = addDays(today, i);
    const noon = new Date(`${ymd}T16:00:00Z`);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(noon);
    if (weekday === "Sun") continue;
    out.push({ ymd, label: new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(noon) });
  }
  return out;
}

export function dateLabel(ymd: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(new Date(`${ymd}T16:00:00Z`));
}

/** "Tue, Oct 14 between 9 AM and 12 PM" when the visit matches an arrival window. */
export function windowForTimes(startHourEt: number, endHourEt: number) {
  return WINDOWS.find((w) => w.startHour === startHourEt && w.endHour === endHourEt) ?? null;
}

const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const hourEt = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(d)) % 24;

/** "9 am", "12:30 pm" (Eastern). */
export function clock(d: Date): string {
  return CLOCK.format(d).replace(":00", "").replace(" AM", " am").replace(" PM", " pm");
}

/** The arrival window promised for a visit: its own window, else a booking-window-shaped visit, else just the start. */
export function arrivalOf(v: { start: Date; end: Date; arrivalStart?: Date | null; arrivalEnd?: Date | null }): { start: Date; end: Date | null } {
  if (v.arrivalStart && v.arrivalEnd && v.arrivalEnd > v.arrivalStart) return { start: v.arrivalStart, end: v.arrivalEnd };
  const onTheHour = v.start.getUTCMinutes() === 0 && v.end.getUTCMinutes() === 0;
  if (onTheHour && windowForTimes(hourEt(v.start), hourEt(v.end))) return { start: v.start, end: v.end };
  return { start: v.start, end: null };
}

/**
 * How a text says the arrival time: "between 9 am and 12 pm", "sometime between 9 am and 6 pm" for the
 * all-day window, or "at 10:30 am" when there's no window.
 */
export function arrivalPhrase(a: { start: Date; end: Date | null }): string {
  if (!a.end) return `at ${clock(a.start)}`;
  const allDay = a.end.getTime() - a.start.getTime() >= 8 * 3_600_000;
  return `${allDay ? "sometime " : ""}between ${clock(a.start)} and ${clock(a.end)}`;
}

/** Short label for screens: "9 am – 12 pm" or "10:30 am". */
export function arrivalLabel(a: { start: Date; end: Date | null }): string {
  return a.end ? `${clock(a.start)} – ${clock(a.end)}` : clock(a.start);
}

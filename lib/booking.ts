// Arrival windows and bookable days (client-safe: no server imports).

export const WINDOWS = [
  { id: "09-12", label: "9 am – 12 pm", startHour: 9, endHour: 12 },
  { id: "12-15", label: "12 pm – 3 pm", startHour: 12, endHour: 15 },
  { id: "15-18", label: "3 pm – 6 pm", startHour: 15, endHour: 18 },
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

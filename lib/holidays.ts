// US federal holidays (plus Christmas Eve / New Year's Eve), computed — no API. Pure: safe for client components.

export type Holiday = { date: string; name: string };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The nth weekday (0 = Sunday) of a month; n = -1 for the last one. */
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return ymd(y, m, lastDay - ((last - weekday + 7) % 7));
}

export function holidaysForYear(y: number): Holiday[] {
  return [
    { date: ymd(y, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(y, 1, 1, 3), name: "Martin Luther King Jr. Day" },
    { date: nthWeekday(y, 2, 1, 3), name: "Presidents' Day" },
    { date: nthWeekday(y, 5, 1, -1), name: "Memorial Day" },
    { date: ymd(y, 6, 19), name: "Juneteenth" },
    { date: ymd(y, 7, 4), name: "Independence Day" },
    { date: nthWeekday(y, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekday(y, 10, 1, 2), name: "Columbus Day" },
    { date: ymd(y, 11, 11), name: "Veterans Day" },
    { date: nthWeekday(y, 11, 4, 4), name: "Thanksgiving" },
    { date: ymd(y, 12, 24), name: "Christmas Eve" },
    { date: ymd(y, 12, 25), name: "Christmas Day" },
    { date: ymd(y, 12, 31), name: "New Year's Eve" },
  ];
}

/** Holidays with from <= date < to ("YYYY-MM-DD"). */
export function holidaysBetween(from: string, to: string): Holiday[] {
  const out: Holiday[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    out.push(...holidaysForYear(y).filter((h) => h.date >= from && h.date < to));
  }
  return out;
}

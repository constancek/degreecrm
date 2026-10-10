import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { addDaysYmd, easternMidnight, easternYmd } from "@/lib/services/dispatch";
import { calendarItems, calendarUsers } from "@/lib/services/calendar";
import { holidaysBetween } from "@/lib/holidays";
import { CalendarView, type CalendarType, type CalendarViewName } from "./calendar-view";

export const metadata: Metadata = { title: "Calendar" };

const VIEWS: CalendarViewName[] = ["month", "week", "3day", "day"];
const TYPES: CalendarType[] = ["all", "estimate", "job", "google"];

const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** The dates a view shows, starting from the anchor date. Weeks start on Sunday. */
function visibleDates(view: CalendarViewName, date: string): string[] {
  let first = date;
  let count = 1;
  if (view === "month") {
    const monthStart = `${date.slice(0, 7)}-01`;
    const nextMonth = addDaysYmd(`${date.slice(0, 7)}-28`, 4).slice(0, 7) + "-01";
    first = addDaysYmd(monthStart, -weekday(monthStart));
    const lastDay = addDaysYmd(nextMonth, -1);
    const last = addDaysYmd(lastDay, 6 - weekday(lastDay));
    count = Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000) + 1;
  } else if (view === "week") {
    first = addDaysYmd(date, -weekday(date));
    count = 7;
  } else if (view === "3day") {
    count = 3;
  }
  return Array.from({ length: count }, (_, i) => addDaysYmd(first, i));
}

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const user = await requireUser();
  const owner = user.role === "owner";
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const view = VIEWS.includes(one("view") as CalendarViewName) ? (one("view") as CalendarViewName) : "month";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(one("date") ?? "") ? one("date")! : easternYmd(new Date());
  const type = TYPES.includes(one("type") as CalendarType) ? (one("type") as CalendarType) : "all";
  const showHolidays = one("holidays") !== "0";

  const users = await calendarUsers(user);
  const userParam = one("user");
  const selectedUser = owner ? (users.some((u) => u.id === userParam) ? userParam! : "all") : user.id;
  const userIds = selectedUser === "all" ? users.map((u) => u.id) : [selectedUser];

  const dates = visibleDates(view, date);
  const endYmd = addDaysYmd(dates.at(-1)!, 1);
  const from = easternMidnight(dates[0]!);
  const to = easternMidnight(endYmd);
  const { items, failed } = await calendarItems(user, { from, to, userIds, google: type === "all" || type === "google" });
  const filtered = items.filter((i) => type === "all" || (type === "google" ? i.type === "google" : i.type === "visit" && i.kind === type));

  const me = users.find((u) => u.id === user.id);

  return (
    <CalendarView
      view={view}
      date={date}
      today={easternYmd(new Date())}
      days={[...dates, endYmd].map((ymd) => ({ ymd, ms: easternMidnight(ymd).getTime() }))}
      items={filtered}
      holidays={showHolidays ? holidaysBetween(dates[0]!, endYmd) : []}
      showHolidays={showHolidays}
      type={type}
      users={users.map((u) => ({ id: u.id, name: u.name, connected: u.connected }))}
      selectedUser={selectedUser}
      meId={user.id}
      myCalendar={{ connected: Boolean(me?.connected), email: me?.calendarEmail ?? null }}
      failed={failed}
      canBook={owner}
      mapsKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || undefined}
    />
  );
}

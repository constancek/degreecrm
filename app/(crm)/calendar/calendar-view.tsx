"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { CalendarItem } from "@/lib/services/calendar";
import type { Holiday } from "@/lib/holidays";
import { NewAppointmentDialog, type AppointmentDefaults } from "./new-appointment";

export type CalendarViewName = "month" | "week" | "3day" | "day";
export type CalendarType = "all" | "estimate" | "job" | "google";

type Day = { ymd: string; ms: number };
type User = { id: string; name: string; connected: boolean };

const TZ = "America/New_York";
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_PX = 52;

const utc = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
function addDays(ymd: string, n: number) {
  const d = utc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(ymd: string, n: number) {
  const d = utc(`${ymd.slice(0, 7)}-01`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
const shortTime = (ms: number) => TIME.format(ms).replace(":00", "").replace(" AM", "a").replace(" PM", "p");

const COLORS = {
  estimate: "border-violet-500 bg-violet-100 text-violet-950",
  job: "border-emerald-600 bg-emerald-100 text-emerald-950",
  google: "border-gray-400 bg-gray-100 text-gray-800",
  holiday: "border-gray-300 bg-[repeating-linear-gradient(135deg,#f3f4f6_0_6px,#e5e7eb_6px_12px)] text-gray-700",
};

function initials(name: string) {
  if (name === "No tech") return "NO TECH";
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Something drawn on one day: a timed block (with minutes from midnight) or an all-day chip. */
type Placed = {
  key: string;
  item: CalendarItem | null;
  holiday?: Holiday;
  allDay: boolean;
  startMin: number;
  endMin: number;
  sortMs: number;
};

function placeOnDays(items: CalendarItem[], holidays: Holiday[], days: Day[]): Map<string, Placed[]> {
  const out = new Map<string, Placed[]>();
  for (let i = 0; i < days.length - 1; i++) out.set(days[i]!.ymd, []);
  for (const h of holidays) out.get(h.date)?.push({ key: `h:${h.date}`, item: null, holiday: h, allDay: true, startMin: 0, endMin: 0, sortMs: 0 });
  for (const item of items) {
    if (item.type === "google" && item.startDate) {
      for (const [ymd, list] of out) {
        if (ymd >= item.startDate && ymd < (item.endDate ?? addDays(item.startDate, 1))) {
          list.push({ key: `${item.id}:${ymd}`, item, allDay: true, startMin: 0, endMin: 0, sortMs: 1 });
        }
      }
      continue;
    }
    const start = item.start!;
    const end = item.end!;
    for (let i = 0; i < days.length - 1; i++) {
      const d0 = days[i]!.ms;
      const d1 = days[i + 1]!.ms;
      if (end <= d0 || start >= d1) continue;
      out.get(days[i]!.ymd)!.push({
        key: `${item.id}:${days[i]!.ymd}`,
        item,
        allDay: false,
        startMin: Math.max(0, (start - d0) / 60_000),
        endMin: Math.min((d1 - d0) / 60_000, (end - d0) / 60_000),
        sortMs: start,
      });
    }
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.sortMs - b.sortMs);
  return out;
}

/** Side-by-side columns for overlapping blocks. */
function layoutColumns(blocks: Placed[]) {
  const res = new Map<string, { col: number; cols: number }>();
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const colsEnd: number[] = [];
  const flush = () => {
    const n = Math.max(1, colsEnd.length);
    for (const b of cluster) res.get(b.key)!.cols = n;
    cluster = [];
    colsEnd.length = 0;
  };
  for (const b of [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)) {
    if (b.startMin >= clusterEnd) flush();
    let col = colsEnd.findIndex((e) => e <= b.startMin);
    if (col === -1) col = colsEnd.length;
    colsEnd[col] = Math.max(b.endMin, b.startMin + 20);
    res.set(b.key, { col, cols: 1 });
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, colsEnd[col]!);
  }
  flush();
  return res;
}

/** Main text: the customer for visits, the event title for Google events. */
function label(p: Placed) {
  if (p.holiday) return p.holiday.name;
  const item = p.item!;
  return item.type === "visit" ? item.customer : item.title;
}

/** Secondary text: what kind of visit, and whose calendar when showing everyone. */
function detail(p: Placed, users: Map<string, string>, showWho: boolean) {
  const item = p.item;
  if (!item) return "";
  const who = showWho ? initials(users.get(item.userId) ?? "") : "";
  const kind = item.type === "visit" ? (item.kind === "estimate" ? "Estimate" : "Job") : "";
  return [kind, who].filter(Boolean).join(" · ");
}

function colorOf(p: Placed) {
  if (p.holiday) return COLORS.holiday;
  const item = p.item!;
  return item.type === "visit" ? COLORS[item.kind] : COLORS.google;
}

/** Wraps an event in the right link: a lead for CRM visits, Google Calendar for your own events. */
function EventLink({
  p,
  className,
  children,
  title,
  style,
}: {
  p: Placed;
  className: string;
  children: React.ReactNode;
  title: string;
  style?: React.CSSProperties;
}) {
  const item = p.item;
  if (item?.type === "visit") {
    return (
      <Link href={`/leads/${item.leadId}`} className={className} style={style} title={title} onClick={(e) => e.stopPropagation()}>
        {children}
      </Link>
    );
  }
  if (item?.type === "google" && item.link) {
    return (
      <a href={item.link} target="_blank" rel="noreferrer" className={className} style={style} title={title} onClick={(e) => e.stopPropagation()}>
        {children}
      </a>
    );
  }
  return (
    <div className={className} style={style} title={title} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

export function CalendarView(props: {
  view: CalendarViewName;
  date: string;
  today: string;
  days: Day[];
  items: CalendarItem[];
  holidays: Holiday[];
  showHolidays: boolean;
  type: CalendarType;
  users: User[];
  selectedUser: string;
  meId: string;
  myCalendar: { connected: boolean; email: string | null };
  failed: string[];
  canBook: boolean;
  showUnassigned?: boolean;
  mapsKey?: string;
}) {
  const { view, date, today, days, items, holidays, users } = props;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [dialog, setDialog] = useState<AppointmentDefaults | null>(null);

  const userNames = useMemo(() => new Map([...users.map((u) => [u.id, u.name] as [string, string]), ["unassigned", "No tech"]]), [users]);
  const showWho = props.selectedUser === "all" && users.length > 1;
  const byDay = useMemo(() => placeOnDays(items, holidays, days), [items, holidays, days]);
  const shown = days.slice(0, -1);

  function href(patch: Record<string, string | null>) {
    const q = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    return `${pathname}?${q.toString()}`;
  }
  const go = (patch: Record<string, string | null>) => router.push(href(patch));

  const step = view === "month" ? null : view === "week" ? 7 : view === "3day" ? 3 : 1;
  const prev = step ? addDays(date, -step) : addMonths(date, -1);
  const next = step ? addDays(date, step) : addMonths(date, 1);
  const rangeLabel =
    view === "month"
      ? MONTH.format(utc(date))
      : view === "day"
        ? LONG.format(utc(date))
        : `${SHORT.format(utc(shown[0]!.ymd))} – ${SHORT.format(utc(shown.at(-1)!.ymd))}, ${shown.at(-1)!.ymd.slice(0, 4)}`;

  function openNew(defaults: Partial<AppointmentDefaults> = {}) {
    const tech = props.selectedUser !== "all" ? props.selectedUser : props.meId;
    setDialog({ date: date < today ? today : date, time: "09:00", techId: tech, ...defaults });
  }

  return (
    <div className="flex flex-1 flex-col p-3 sm:p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold sm:text-2xl">Calendar</h1>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <p className="text-right text-xs leading-tight text-gray-600">
            <span className="font-semibold text-gray-800">Google Calendar</span>
            <br />
            {props.myCalendar.connected ? (
              <span className="text-emerald-700">Connected{props.myCalendar.email ? ` · ${props.myCalendar.email}` : ""}</span>
            ) : (
              <Link href="/settings" className="text-amber-700 underline">
                Not connected – connect in Settings
              </Link>
            )}
          </p>
          {props.canBook && (
            <button type="button" className="btn-primary" onClick={() => openNew()}>
              + New appointment
            </button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border bg-white text-sm" role="tablist" aria-label="View">
          {(
            [
              ["month", "Month"],
              ["week", "Week"],
              ["3day", "3 Days"],
              ["day", "Day"],
            ] as const
          ).map(([v, l]) => (
            <Link
              key={v}
              href={href({ view: v })}
              role="tab"
              aria-selected={view === v}
              className={`px-3 py-2 ${view === v ? "bg-brand text-white" : "text-gray-700 hover:bg-gray-50"}`}
            >
              {l}
            </Link>
          ))}
        </div>
        <div className="flex items-center rounded-md border bg-white text-sm">
          <Link href={href({ date: prev })} className="px-3 py-2 text-gray-700 hover:bg-gray-50" aria-label="Previous">
            ‹
          </Link>
          <span className="min-w-36 px-1 text-center font-medium">{rangeLabel}</span>
          <Link href={href({ date: next })} className="px-3 py-2 text-gray-700 hover:bg-gray-50" aria-label="Next">
            ›
          </Link>
        </div>
        <Link href={href({ date: today })} className="btn-secondary">
          Today
        </Link>
        <select className="input w-auto" aria-label="Event type" value={props.type} onChange={(e) => go({ type: e.target.value === "all" ? null : e.target.value })}>
          <option value="all">All event types</option>
          <option value="estimate">Estimates</option>
          <option value="job">Job visits</option>
          <option value="google">Google Calendar</option>
        </select>
        {users.length > 1 && (
          <select className="input w-auto max-w-60" aria-label="Person" value={props.selectedUser} onChange={(e) => go({ user: e.target.value === "all" ? null : e.target.value })}>
            <option value="all">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.connected ? "" : " (no Google Calendar)"}
              </option>
            ))}
            {props.showUnassigned && <option value="unassigned">No tech yet</option>}
          </select>
        )}
        <label className="ml-1 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" className="size-4" checked={props.showHolidays} onChange={(e) => go({ holidays: e.target.checked ? null : "0" })} />
          Holidays
        </label>
      </div>

      {props.failed.length > 0 && (
        <p className="mt-3 rounded-md bg-amber-50 p-2 text-sm text-amber-800">
          Couldn&apos;t load Google Calendar for {props.failed.join(", ")}. They may need to reconnect it in Settings.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600">
        <Legend className={COLORS.estimate} text="Estimate" />
        <Legend className={COLORS.job} text="Job visit" />
        <Legend className={COLORS.google} text="Google Calendar" />
      </div>

      {view === "month" ? (
        <MonthGrid
          shown={shown}
          month={date.slice(0, 7)}
          today={today}
          byDay={byDay}
          users={userNames}
          showWho={showWho}
          dayHref={(ymd) => href({ view: "day", date: ymd })}
        />
      ) : (
        <TimeGrid
          shown={shown}
          today={today}
          byDay={byDay}
          users={userNames}
          showWho={showWho}
          dayHref={(ymd) => href({ view: "day", date: ymd })}
          onSlot={props.canBook ? (ymd, minutes) => openNew({ date: ymd, time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` }) : undefined}
        />
      )}

      {dialog && (
        <NewAppointmentDialog
          defaults={dialog}
          staff={users.map((u) => ({ id: u.id, name: u.name }))}
          mapsKey={props.mapsKey}
          onClose={() => setDialog(null)}
          onBooked={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Legend({ className, text }: { className: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-4 rounded-sm border-l-4 ${className}`} />
      {text}
    </span>
  );
}

function MonthGrid(props: {
  shown: Day[];
  month: string;
  today: string;
  byDay: Map<string, Placed[]>;
  users: Map<string, string>;
  showWho: boolean;
  dayHref: (ymd: string) => string;
}) {
  const MAX = 3;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-white">
      <div className="grid grid-cols-7 border-b bg-gray-50 text-center text-xs font-semibold text-gray-600 sm:text-sm">
        {DOW.map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {props.shown.map(({ ymd }) => {
          const list = props.byDay.get(ymd) ?? [];
          const inMonth = ymd.startsWith(props.month);
          const isToday = ymd === props.today;
          return (
            <div key={ymd} className={`min-h-24 border-r border-b p-1 sm:min-h-32 ${inMonth ? "" : "bg-gray-50/70"} ${isToday ? "bg-amber-50" : ""}`} data-day={ymd}>
              <div className="flex justify-end">
                <Link
                  href={props.dayHref(ymd)}
                  className={`grid size-7 place-items-center rounded-full text-sm ${isToday ? "bg-brand font-semibold text-white" : inMonth ? "text-gray-800 hover:bg-gray-100" : "text-gray-500 hover:bg-gray-100"}`}
                >
                  {Number(ymd.slice(8))}
                </Link>
              </div>
              <div className="mt-0.5 space-y-1">
                {/* Phones: colored bars only; tap the date for the day view. */}
                {list.length > 0 && (
                  <Link href={props.dayHref(ymd)} className="flex flex-wrap gap-0.5 px-0.5 sm:hidden" aria-label={`${list.length} on this day`}>
                    {list.slice(0, 6).map((p) => (
                      <span key={p.key} className={`h-1.5 w-3 rounded-full border-l-4 ${colorOf(p)}`} />
                    ))}
                  </Link>
                )}
                {list.slice(0, MAX).map((p) => {
                  const text = label(p);
                  const sub = detail(p, props.users, props.showWho);
                  const time = p.allDay ? "" : `${shortTime(p.item!.type === "visit" ? p.item!.start : p.item!.start!)} `;
                  const done = p.item?.type === "visit" && p.item.status === "completed";
                  return (
                    <EventLink
                      key={p.key}
                      p={p}
                      title={`${time}${text}${sub ? ` (${sub})` : ""}`}
                      className={`hidden truncate rounded border-l-4 px-1.5 py-0.5 text-xs leading-tight sm:block ${colorOf(p)} ${done ? "opacity-60" : ""}`}
                    >
                      {time && <span className="font-semibold">{time}</span>}
                      {text}
                    </EventLink>
                  );
                })}
                {list.length > MAX && (
                  <Link href={props.dayHref(ymd)} className="hidden px-1 text-xs font-medium text-brand sm:block">
                    +{list.length - MAX} more
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeGrid(props: {
  shown: Day[];
  today: string;
  byDay: Map<string, Placed[]>;
  users: Map<string, string>;
  showWho: boolean;
  dayHref: (ymd: string) => string;
  onSlot?: (ymd: string, minutes: number) => void;
}) {
  // 6 am – 9 pm, stretched if anything falls outside.
  let startHour = 6;
  let endHour = 21;
  for (const list of props.byDay.values()) {
    for (const p of list) {
      if (p.allDay) continue;
      startHour = Math.min(startHour, Math.floor(p.startMin / 60));
      endHour = Math.max(endHour, Math.ceil(p.endMin / 60));
    }
  }
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const cols = `3.5rem repeat(${props.shown.length}, minmax(0, 1fr))`;
  const anyAllDay = props.shown.some(({ ymd }) => (props.byDay.get(ymd) ?? []).some((p) => p.allDay));

  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-white">
      <div className="grid border-b bg-gray-50" style={{ gridTemplateColumns: cols }}>
        <div />
        {props.shown.map(({ ymd }) => {
          const d = utc(ymd);
          const isToday = ymd === props.today;
          return (
            <Link key={ymd} href={props.dayHref(ymd)} className="border-l py-2 text-center text-sm hover:bg-gray-100">
              <span className="text-gray-600">{DOW[d.getUTCDay()]}</span>{" "}
              <span className={`inline-grid size-7 place-items-center rounded-full font-semibold ${isToday ? "bg-brand text-white" : ""}`}>{d.getUTCDate()}</span>
            </Link>
          );
        })}
      </div>
      {anyAllDay && (
        <div className="grid border-b" style={{ gridTemplateColumns: cols }}>
          <div className="px-1 py-1 text-right text-xs text-gray-500">all day</div>
          {props.shown.map(({ ymd }) => (
            <div key={ymd} className="space-y-1 border-l p-1">
              {(props.byDay.get(ymd) ?? [])
                .filter((p) => p.allDay)
                .map((p) => {
                  const text = label(p);
                  return (
                    <EventLink key={p.key} p={p} title={text} className={`block truncate rounded border-l-4 px-1.5 py-0.5 text-xs ${colorOf(p)}`}>
                      {text}
                    </EventLink>
                  );
                })}
            </div>
          ))}
        </div>
      )}
      <div className="max-h-[calc(100dvh-16rem)] min-h-96 overflow-y-auto">
        <div className="grid pt-2" style={{ gridTemplateColumns: cols }}>
          <div>
            {hours.map((h) => (
              <div key={h} className="relative pr-1 text-right text-xs text-gray-500" style={{ height: HOUR_PX }}>
                <span className="relative -top-2">{h === 0 ? "" : `${((h + 11) % 12) + 1} ${h < 12 ? "am" : "pm"}`}</span>
              </div>
            ))}
          </div>
          {props.shown.map(({ ymd }) => {
            const timed = (props.byDay.get(ymd) ?? []).filter((p) => !p.allDay);
            const layout = layoutColumns(timed);
            return (
              <div
                key={ymd}
                className={`relative border-l ${props.onSlot ? "cursor-pointer" : ""} ${ymd === props.today ? "bg-amber-50/40" : ""}`}
                style={{ height: hours.length * HOUR_PX }}
                data-day={ymd}
                onClick={(e) => {
                  if (!props.onSlot) return;
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                  const minutes = Math.floor((startHour * 60 + (y / HOUR_PX) * 60) / 30) * 30;
                  props.onSlot(ymd, Math.min(minutes, 23 * 60 + 30));
                }}
              >
                {hours.map((h) => (
                  <div key={h} className="border-b border-gray-100" style={{ height: HOUR_PX }} />
                ))}
                {timed.map((p) => {
                  const pos = layout.get(p.key)!;
                  const top = ((p.startMin - startHour * 60) / 60) * HOUR_PX;
                  const height = Math.max(20, ((p.endMin - p.startMin) / 60) * HOUR_PX - 2);
                  const item = p.item!;
                  const s = item.type === "visit" ? item.start : item.start!;
                  const en = item.type === "visit" ? item.end : item.end!;
                  const text = label(p);
                  const sub = detail(p, props.users, props.showWho);
                  const done = item.type === "visit" && item.status === "completed";
                  return (
                    <EventLink
                      key={p.key}
                      p={p}
                      title={`${TIME.format(s)}–${TIME.format(en)} ${text}${sub ? ` (${sub})` : ""}`}
                      style={{ top, height, left: `calc(${(pos.col / pos.cols) * 100}% + 2px)`, width: `calc(${100 / pos.cols}% - 4px)` }}
                      className={`absolute overflow-hidden rounded border-l-4 px-1.5 py-0.5 text-xs leading-tight shadow-sm ${colorOf(p)} ${done ? "opacity-60" : ""}`}
                    >
                      <span className="block font-semibold">
                        {TIME.format(s)} – {TIME.format(en)}
                      </span>
                      <span className="block font-medium">{text}</span>
                      {sub && height > 40 && <span className="block text-xs opacity-80">{sub}</span>}
                      {item.type === "visit" && item.address && height > 56 && <span className="block truncate text-xs opacity-80">{item.address}</span>}
                    </EventLink>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

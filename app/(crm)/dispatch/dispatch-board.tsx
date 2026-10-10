"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { loadGoogleMaps } from "@/lib/client/maps-loader";
import { findSlotsAction, placeOnBoardAction } from "../ops-actions";

type Tech = { id: string; name: string; color: string; calendar: boolean };
type Visit = {
  id: string;
  techId: string;
  leadId: string;
  jobId: string | null;
  kind: string;
  status: string;
  start: number;
  end: number;
  customer: string;
  title: string;
  address: string;
  lat: number | null;
  lng: number | null;
};
type Busy = { techId: string; start: number; end: number };
type Unscheduled = { key: string; leadId: string; jobId: string | null; kind: "job" | "estimate"; customer: string; title: string; address: string; minutes: number };

const FIRST_HOUR = 7;
const LAST_HOUR = 19;
const SLOT_MIN = 15;
const ROW_PX = 12;
const ROWS = ((LAST_HOUR - FIRST_HOUR) * 60) / SLOT_MIN;
const HOUR = 3_600_000;

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

function shiftYmd(ymd: string, days: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function DispatchBoard(props: {
  view: "day" | "week";
  date: string;
  dayStarts: { ymd: string; ms: number }[];
  mapsKey: string | null;
  techs: Tech[];
  visits: Visit[];
  busy: Busy[];
  unscheduled: Unscheduled[];
}) {
  const router = useRouter();
  const dndId = useId();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const techColor = useMemo(() => new Map(props.techs.map((t) => [t.id, t.color])), [props.techs]);
  const step = props.view === "week" ? 7 : 1;

  function place(input: Parameters<typeof placeOnBoardAction>[0]) {
    setError(null);
    start(async () => {
      const r = await placeOnBoardAction(input);
      if (r.error) setError(r.error);
      router.refresh();
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const over = e.over?.id ? String(e.over.id) : null;
    if (!over) return;
    const [techId, startStr] = over.split("|") as [string, string];
    const active = String(e.active.id);
    const visit = active.startsWith("visit:") ? props.visits.find((v) => v.id === active.slice(6)) : null;
    const item = props.unscheduled.find((u) => u.key === active);

    let startMs: number;
    if (props.view === "day") startMs = Number(startStr);
    else {
      // Week view drops onto a day: keep the visit's time of day, or 9 am for new ones.
      const dayMs = Number(startStr);
      const day = props.dayStarts.find((d) => d.ms === dayMs)!;
      if (visit) {
        const origDay = [...props.dayStarts].reverse().find((d) => d.ms <= visit.start)?.ms ?? dayMs;
        startMs = day.ms + (visit.start - origDay);
      } else startMs = day.ms + 9 * HOUR;
    }
    if (visit) {
      if (visit.techId === techId && visit.start === startMs) return;
      place({ visitId: visit.id, techId, start: new Date(startMs).toISOString(), durationMinutes: Math.round((visit.end - visit.start) / 60_000) });
    } else if (item) {
      place({ leadId: item.leadId, jobId: item.jobId ?? undefined, kind: item.kind, techId, start: new Date(startMs).toISOString(), durationMinutes: item.minutes });
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-lg font-semibold">Dispatch</h1>
        <div className="flex items-center gap-1">
          <Link href={`/dispatch?view=${props.view}&date=${shiftYmd(props.date, -step)}`} className="btn-secondary px-2 py-1" aria-label="Previous">
            ←
          </Link>
          <Link href={`/dispatch?view=${props.view}`} className="btn-secondary px-2 py-1">
            Today
          </Link>
          <Link href={`/dispatch?view=${props.view}&date=${shiftYmd(props.date, step)}`} className="btn-secondary px-2 py-1" aria-label="Next">
            →
          </Link>
        </div>
        <span className="font-medium">
          {DAY_LABEL.format(new Date(props.dayStarts[0]!.ms + 12 * HOUR))}
          {props.view === "week" ? ` – ${DAY_LABEL.format(new Date(props.dayStarts.at(-1)!.ms + 12 * HOUR))}` : ""}
        </span>
        <div className="ml-auto flex gap-1 text-sm">
          <Link href={`/dispatch?view=day&date=${props.date}`} className={props.view === "day" ? "btn-primary px-3 py-1" : "btn-secondary px-3 py-1"}>
            Day
          </Link>
          <Link href={`/dispatch?view=week&date=${props.date}`} className={props.view === "week" ? "btn-primary px-3 py-1" : "btn-secondary px-3 py-1"}>
            Week
          </Link>
        </div>
      </div>
      {error && <p className="mx-4 mb-2 rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {pending && <p className="mx-4 mb-2 text-xs text-gray-500">Saving…</p>}

      <DndContext id={dndId} sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid flex-1 gap-3 px-4 pb-4 xl:grid-cols-[260px_1fr]">
          <aside className="space-y-3">
            <section className="card p-3">
              <h2 className="text-sm font-semibold">To schedule ({props.unscheduled.length})</h2>
              <p className="text-xs text-gray-500">Drag onto a tech and time.</p>
              <ul className="mt-2 space-y-2">
                {props.unscheduled.map((u) => (
                  <UnscheduledCard key={u.key} item={u} />
                ))}
                {props.unscheduled.length === 0 && <li className="text-xs text-gray-500">All caught up.</li>}
              </ul>
            </section>
            <SlotFinder items={props.unscheduled} onBook={(s, item) => place({ leadId: item.leadId, jobId: item.jobId ?? undefined, kind: item.kind, techId: s.techId, start: s.start, durationMinutes: Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000) })} />
          </aside>

          <div className="min-w-0 space-y-3">
            {props.view === "day" ? (
              <DayGrid dayStart={props.dayStarts[0]!.ms} techs={props.techs} visits={props.visits} busy={props.busy} techColor={techColor} />
            ) : (
              <WeekGrid dayStarts={props.dayStarts} techs={props.techs} visits={props.visits} busy={props.busy} techColor={techColor} />
            )}
            {props.view === "day" && <DispatchMap mapsKey={props.mapsKey} visits={props.visits} techs={props.techs} />}
          </div>
        </div>
      </DndContext>
    </div>
  );
}

function UnscheduledCard({ item }: { item: Unscheduled }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.key });
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-unscheduled={item.key}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={`cursor-grab rounded-md border bg-white p-2 text-xs ${isDragging ? "z-50 shadow-lg" : ""} ${item.kind === "job" ? "border-l-4 border-l-brand" : "border-l-4 border-l-amber-500"}`}
    >
      <p className="font-medium">{item.customer}</p>
      <p className="text-gray-600">{item.title}</p>
      <p className="text-gray-400">
        {item.kind === "job" ? "Job" : "Estimate"} · {item.minutes / 60} h{item.address ? ` · ${item.address.split(",")[0]}` : ""}
      </p>
    </li>
  );
}

function VisitBlock({ v, color, style, compact }: { v: Visit; color: string; style?: React.CSSProperties; compact?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `visit:${v.id}`, disabled: ["done", "cancelled"].includes(v.status) });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-visit={v.id}
      style={{ ...style, borderLeftColor: color, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined }}
      className={`overflow-hidden rounded border border-l-4 bg-white px-1.5 py-0.5 text-[11px] leading-tight shadow-sm ${isDragging ? "z-50 shadow-lg" : "z-10"} ${v.status === "done" ? "opacity-60" : ""}`}
      title={`${v.customer} · ${v.title} · ${TIME.format(v.start)}–${TIME.format(v.end)}`}
    >
      <Link href={v.jobId ? `/jobs/${v.jobId}` : `/leads/${v.leadId}`} className="font-semibold hover:underline" onPointerDown={(e) => e.stopPropagation()}>
        {v.customer}
      </Link>
      {!compact && <p className="truncate text-gray-600">{v.title}</p>}
      <p className="text-gray-500">
        {TIME.format(v.start)}
        {v.kind === "estimate" ? " · est." : ""}
      </p>
    </div>
  );
}

function Cell({ id, className, style, children }: { id: string; className?: string; style?: React.CSSProperties; children?: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} data-cell={id} className={`${className ?? ""} ${isOver ? "bg-brand/10" : ""}`} style={style}>
      {children}
    </div>
  );
}

function DayGrid({ dayStart, techs, visits, busy, techColor }: { dayStart: number; techs: Tech[]; visits: Visit[]; busy: Busy[]; techColor: Map<string, string> }) {
  const gridStart = dayStart + FIRST_HOUR * HOUR;
  const top = (ms: number) => ((ms - gridStart) / 60_000 / SLOT_MIN) * ROW_PX;
  const height = (a: number, b: number) => Math.max(ROW_PX * 2, ((b - a) / 60_000 / SLOT_MIN) * ROW_PX);
  return (
    <div className="card overflow-x-auto">
      <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `56px repeat(${techs.length}, minmax(160px, 1fr))` }}>
        <div className="border-b p-2" />
        {techs.map((t) => (
          <div key={t.id} className="border-b border-l p-2 text-sm font-semibold" style={{ color: t.color }}>
            {t.name}
            {!t.calendar && <span className="ml-1 text-[10px] font-normal text-gray-400">(no calendar)</span>}
          </div>
        ))}
        <div className="relative" style={{ height: ROWS * ROW_PX }}>
          {Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, h) => (
            <div key={h} className="absolute right-1 text-[10px] text-gray-400" style={{ top: Math.max(0, h * 4 * ROW_PX - 5) }}>
              {TIME.format(new Date(gridStart + h * HOUR)).replace(":00", "")}
            </div>
          ))}
        </div>
        {techs.map((t) => (
          <div key={t.id} className="relative border-l" style={{ height: ROWS * ROW_PX }} data-tech-column={t.id}>
            {Array.from({ length: ROWS }, (_, r) => (
              <Cell
                key={r}
                id={`${t.id}|${gridStart + r * SLOT_MIN * 60_000}`}
                className={`absolute inset-x-0 ${r % 4 === 0 ? "border-t border-gray-200" : ""}`}
                style={{ top: r * ROW_PX, height: ROW_PX }}
              />
            ))}
            {busy
              .filter((b) => b.techId === t.id)
              .map((b, i) => (
                <div
                  key={i}
                  className="pointer-events-none absolute inset-x-1 rounded bg-gray-200/80 text-[10px] text-gray-500"
                  style={{ top: top(b.start), height: height(b.start, b.end) }}
                >
                  &nbsp;Busy
                </div>
              ))}
            {visits
              .filter((v) => v.techId === t.id)
              .map((v) => (
                <VisitBlock
                  key={v.id}
                  v={v}
                  color={techColor.get(v.techId) ?? "#6b7280"}
                  style={{ position: "absolute", left: 4, right: 4, top: Math.max(0, top(v.start)), height: height(v.start, v.end) }}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekGrid({ dayStarts, techs, visits, busy, techColor }: { dayStarts: { ymd: string; ms: number }[]; techs: Tech[]; visits: Visit[]; busy: Busy[]; techColor: Map<string, string> }) {
  return (
    <div className="card overflow-x-auto">
      <div className="grid min-w-[900px]" style={{ gridTemplateColumns: `120px repeat(${dayStarts.length}, minmax(110px, 1fr))` }}>
        <div className="border-b p-2" />
        {dayStarts.map((d) => (
          <div key={d.ymd} className="border-b border-l p-2 text-center text-xs font-semibold">
            <Link href={`/dispatch?view=day&date=${d.ymd}`} className="hover:underline">
              {DAY_LABEL.format(new Date(d.ms + 12 * HOUR))}
            </Link>
          </div>
        ))}
        {techs.map((t) => (
          <div key={t.id} className="contents">
            <div className="border-b p-2 text-sm font-semibold" style={{ color: t.color }}>
              {t.name}
            </div>
            {dayStarts.map((d) => {
              const end = d.ms + 24 * HOUR;
              const dayVisits = visits.filter((v) => v.techId === t.id && v.start >= d.ms && v.start < end);
              const busyHours = busy.filter((b) => b.techId === t.id && b.start < end && b.end > d.ms).reduce((s, b) => s + (Math.min(b.end, end) - Math.max(b.start, d.ms)) / HOUR, 0);
              return (
                <Cell key={d.ymd} id={`${t.id}|${d.ms}`} className="min-h-24 space-y-1 border-b border-l p-1">
                  {dayVisits.map((v) => (
                    <VisitBlock key={v.id} v={v} color={techColor.get(v.techId) ?? "#6b7280"} compact />
                  ))}
                  {busyHours > 0 && <p className="text-[10px] text-gray-400">{busyHours.toFixed(1)} h busy (Google)</p>}
                </Cell>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DispatchMap({ mapsKey, visits, techs }: { mapsKey: string | null; visits: Visit[]; techs: Tech[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pins = visits.filter((v) => v.lat != null && v.lng != null && v.status !== "cancelled");

  useEffect(() => {
    if (!mapsKey || !ref.current) return;
    let cancelled = false;
    (async () => {
      try {
        await loadGoogleMaps(mapsKey);
        const { Map } = (await google.maps.importLibrary("maps")) as google.maps.MapsLibrary;
        const { AdvancedMarkerElement, PinElement } = (await google.maps.importLibrary("marker")) as google.maps.MarkerLibrary;
        if (cancelled || !ref.current) return;
        const map = new Map(ref.current, { center: { lat: 39.1031, lng: -84.512 }, zoom: 10, mapId: "DEMO_MAP_ID", disableDefaultUI: true, zoomControl: true });
        const bounds = new google.maps.LatLngBounds();
        for (const v of pins) {
          const color = techs.find((t) => t.id === v.techId)?.color ?? "#6b7280";
          const pin = new PinElement({ background: color, borderColor: "#ffffff", glyphColor: "#ffffff" });
          const marker = new AdvancedMarkerElement({ map, position: { lat: v.lat!, lng: v.lng! }, content: pin.element, title: `${TIME.format(v.start)} ${v.customer}` });
          marker.addListener("click", () => {
            window.location.href = v.jobId ? `/jobs/${v.jobId}` : `/leads/${v.leadId}`;
          });
          bounds.extend({ lat: v.lat!, lng: v.lng! });
        }
        if (pins.length > 1) map.fitBounds(bounds, 40);
        else if (pins.length === 1) map.setCenter({ lat: pins[0]!.lat!, lng: pins[0]!.lng! });
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapsKey, pins, techs]);

  if (!mapsKey) return <p className="card p-4 text-sm text-gray-500">Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to show the map.</p>;
  return (
    <div className="card overflow-hidden">
      {error && <p className="p-2 text-sm text-red-700">Map: {error} (enable Maps JavaScript API for the browser key)</p>}
      <div ref={ref} className="h-80 w-full" aria-label="Map of today's visits" />
      {pins.length === 0 && <p className="p-2 text-xs text-gray-500">No mapped visits this day.</p>}
    </div>
  );
}

type SlotResult = { techId: string; techName: string; start: string; end: string; driveMinutes: number | null; fromWhere: string };

function SlotFinder({ items, onBook }: { items: Unscheduled[]; onBook: (s: SlotResult, item: Unscheduled) => void }) {
  const [key, setKey] = useState(items[0]?.key ?? "");
  const item = items.find((i) => i.key === key) ?? items[0];
  const [hours, setHours] = useState<number>(item ? item.minutes / 60 : 2);
  const [drive, setDrive] = useState(30);
  const [request, setRequest] = useState("");
  const [result, setResult] = useState<{ slots?: SlotResult[]; error?: string; parsed?: string } | null>(null);
  const [pending, start] = useTransition();
  if (!items.length) return null;
  return (
    <section className="card space-y-2 p-3 text-sm">
      <h2 className="font-semibold">Find a slot</h2>
      <select
        className="input"
        value={key}
        onChange={(e) => {
          setKey(e.target.value);
          const it = items.find((i) => i.key === e.target.value);
          if (it) setHours(it.minutes / 60);
        }}
        aria-label="Job or estimate"
      >
        {items.map((i) => (
          <option key={i.key} value={i.key}>
            {i.customer}: {i.kind === "job" ? "job" : "estimate"}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <label className="flex-1 text-xs">
          Hours
          <input className="input" type="number" min={0.5} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        <label className="flex-1 text-xs">
          Max drive (min)
          <input className="input" type="number" min={5} step={5} value={drive} onChange={(e) => setDrive(Number(e.target.value))} />
        </label>
      </div>
      <input
        className="input"
        placeholder="Or ask: “4-hour install next week within 20 min”"
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        aria-label="Ask Claude"
      />
      <button
        className="btn-secondary w-full"
        disabled={pending || !item}
        onClick={() => start(async () => setResult(await findSlotsAction({ leadId: item!.leadId, durationHours: hours, maxDriveMinutes: drive, request })))}
      >
        {pending ? "Searching…" : "Find next openings"}
      </button>
      {result?.parsed && <p className="text-xs text-gray-500">Searching: {result.parsed}</p>}
      {result?.error && <p className="text-red-700">{result.error}</p>}
      {result?.slots && (
        <ul className="space-y-1" aria-label="Open slots">
          {result.slots.length === 0 && <li className="text-gray-500">No openings found. Try a longer drive or later dates.</li>}
          {result.slots.map((s) => (
            <li key={`${s.techId}${s.start}`} className="flex items-center gap-2 rounded border p-2">
              <div className="flex-1">
                <p className="font-medium">
                  {DAY_LABEL.format(new Date(s.start))} {TIME.format(new Date(s.start))}
                </p>
                <p className="text-xs text-gray-500">
                  {s.techName}
                  {s.driveMinutes != null ? ` · ~${s.driveMinutes} min from ${s.fromWhere}` : ""}
                </p>
              </div>
              <button className="btn-primary px-2 py-1 text-xs" onClick={() => onBook(s, item!)}>
                Book
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

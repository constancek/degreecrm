"use client";

import { useBoardSensors } from "@/lib/client/dnd-sensors";
import Link from "next/link";
import { useEffect, useId, useOptimistic, useState, useTransition } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { STAGES, tradeLabel } from "@/lib/stages";
import { markDragged, suppressClickAfterDrag } from "@/lib/client/drag-click-guard";
import { initials, timeAgo } from "@/lib/format";
import type { LeadStage, Trade } from "@/generated/prisma/enums";
import { changeStageAction, planStageMoveAction } from "../actions";
import { useRouter } from "next/navigation";
import { StageMoveDialog } from "./stage-move-dialog";
import type { StagePlan } from "@/lib/services/stage-moves";
import { ChevronLeft } from "@/components/ui/icons";

export type BoardLead = {
  id: string;
  title: string;
  trade: Trade;
  stage: LeadStage;
  customerName: string;
  street: string | null;
  assignee: string | null;
  stageChangedAt: string;
  requested: string | null;
  /** Next open visit: "Tue, Oct 14, 9 am – 12 pm". */
  booked: string | null;
  noTech: boolean;
  late: string | null;
  fee: string | null;
};

const TRADE_COLORS: Record<Trade, string> = {
  hvac: "bg-sky-100 text-sky-800",
  plumbing: "bg-teal-100 text-teal-800",
  electrical: "bg-amber-100 text-amber-800",
};

export function PipelineBoard({ leads, showLost }: { leads: BoardLead[]; showLost: boolean }) {
  const [optimistic, moveOptimistic] = useOptimistic(leads, (state, move: { id: string; stage: LeadStage }) =>
    state.map((l) => (l.id === move.id ? { ...l, stage: move.stage, stageChangedAt: new Date().toISOString() } : l)),
  );
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const sensors = useBoardSensors();

  // A stable id keeps dnd-kit's aria ids identical on server and client (no hydration mismatch).
  const dndId = useId();
  const columns = STAGES.filter((s) => s.id !== "lost" || showLost);

  // Collapsed columns are remembered on this device.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pipeline:collapsed") ?? "[]");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration (server has no localStorage)
      if (Array.isArray(saved)) setCollapsed(new Set(saved.filter((x) => typeof x === "string")));
    } catch {}
  }, []);
  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("pipeline:collapsed", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }

  const router = useRouter();
  const [dialog, setDialog] = useState<{ lead: BoardLead; stage: LeadStage; plan: StagePlan } | null>(null);

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    const stage = e.over?.id as LeadStage | undefined;
    const lead = optimistic.find((l) => l.id === id);
    if (!lead || !stage || lead.stage === stage) return;
    setError(null);
    startTransition(async () => {
      // Ask what this stage needs; plain moves happen right away, real work opens a dialog.
      const res = await planStageMoveAction(id, stage);
      if (res.error || !res.plan) {
        setError(res.error ?? "Couldn't move the card");
        return;
      }
      if (res.plan.kind === "simple") {
        moveOptimistic({ id, stage });
        const r = await changeStageAction(id, stage);
        if (r.error) setError(r.error);
      } else {
        setDialog({ lead, stage, plan: res.plan });
      }
    });
  }

  return (
    <>
      {error && <p role="alert" className="mx-4 mb-2 rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <DndContext id={dndId} sensors={sensors} onDragStart={markDragged} onDragEnd={(e) => {
          markDragged();
          onDragEnd(e);
        }}>
        <div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
          {columns.map((col) => (
            <Column
              key={col.id}
              id={col.id}
              label={col.label}
              hint={col.enters}
              leads={optimistic.filter((l) => l.stage === col.id)}
              collapsed={collapsed.has(col.id)}
              onToggle={() => toggle(col.id)}
            />
          ))}
        </div>
      </DndContext>
      {dialog && (
        <StageMoveDialog
          leadId={dialog.lead.id}
          customer={dialog.lead.customerName}
          stage={dialog.stage}
          plan={dialog.plan}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function Column({
  id,
  label,
  hint,
  leads,
  collapsed,
  onToggle,
}: {
  id: LeadStage;
  label: string;
  hint: string;
  leads: BoardLead[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  if (collapsed) {
    // Still a drop target; tap to expand.
    return (
      <section
        ref={setNodeRef}
        data-stage={id}
        aria-label={label}
        className={`flex w-11 shrink-0 flex-col items-center rounded-lg border bg-gray-100/80 py-2 ${isOver ? "border-brand ring-2 ring-brand/20" : "border-gray-200"}`}
      >
        <button type="button" onClick={onToggle} className="flex flex-1 flex-col items-center gap-2" title={`Show ${label}`} aria-label={`Show ${label} (${leads.length})`}>
          <span className="rounded-full bg-white px-1.5 text-xs font-semibold text-gray-700">{leads.length}</span>
          <span className="text-xs font-semibold whitespace-nowrap text-gray-700 [writing-mode:vertical-rl]">{label}</span>
        </button>
      </section>
    );
  }
  return (
    <section
      ref={setNodeRef}
      data-stage={id}
      aria-label={label}
      className={`flex w-60 shrink-0 flex-col rounded-lg border bg-gray-100/80 ${isOver ? "border-brand ring-2 ring-brand/20" : "border-gray-200"}`}
    >
      <header className="flex items-center justify-between gap-2 px-3 pt-3 pb-2" title={hint}>
        <h2 className="text-sm font-semibold text-gray-800">{label}</h2>
        <span className="ml-auto text-xs text-gray-500">{leads.length}</span>
        <button type="button" onClick={onToggle} className="icon-btn -my-1 -mr-1 hover:bg-gray-200" aria-label={`Collapse ${label}`} title="Collapse">
          <ChevronLeft />
        </button>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
        {leads.map((lead) => (
          <Card key={lead.id} lead={lead} />
        ))}
      </div>
    </section>
  );
}

function Card({ lead }: { lead: BoardLead }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: lead.id });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      data-lead-id={lead.id}
      className={`card cursor-grab p-3 text-sm active:cursor-grabbing ${isDragging ? "z-10 shadow-lg" : ""}`}
    >
      <Link href={`/leads/${lead.id}`} className="font-medium text-gray-900 hover:underline" draggable={false} onClick={suppressClickAfterDrag}>
        {lead.customerName}
      </Link>
      <p className="mt-0.5 line-clamp-2 text-gray-600">{lead.title}</p>
      {lead.street && <p className="mt-0.5 truncate text-xs text-gray-500">{lead.street}</p>}
      {lead.requested && <p className="mt-1 text-xs font-medium text-amber-700">Requested {lead.requested}</p>}
      {lead.booked && <p className="mt-1 text-xs font-medium text-gray-700">{lead.booked}</p>}
      {(lead.noTech || lead.late || lead.fee) && (
        <div className="mt-1 flex flex-wrap gap-1 text-xs font-medium">
          {lead.noTech && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800">No tech</span>}
          {lead.late && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">Late · ~{lead.late}</span>}
          {lead.fee && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">{lead.fee}</span>}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 font-medium ${TRADE_COLORS[lead.trade]}`}>{tradeLabel(lead.trade)}</span>
        <span className="text-gray-500">{timeAgo(lead.stageChangedAt)}</span>
        {lead.assignee ? (
          <span
            title={lead.assignee}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white"
          >
            {initials(lead.assignee)}
          </span>
        ) : (
          <span className="ml-auto text-gray-500">Unassigned</span>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useId, useOptimistic, useState, useTransition } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { STAGES, tradeLabel } from "@/lib/stages";
import { markDragged, suppressClickAfterDrag } from "@/lib/client/drag-click-guard";
import { initials, timeAgo } from "@/lib/format";
import type { LeadStage, Trade } from "@/generated/prisma/enums";
import { changeStageAction } from "../actions";

export type BoardLead = {
  id: string;
  title: string;
  trade: Trade;
  stage: LeadStage;
  customerName: string;
  street: string | null;
  assignee: string | null;
  stageChangedAt: string;
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
  const sensors = useSensors(
    // A small distance threshold keeps plain clicks working as links.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  // A stable id keeps dnd-kit's aria ids identical on server and client (no hydration mismatch).
  const dndId = useId();
  const columns = STAGES.filter((s) => s.id !== "lost" || showLost);

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    const stage = e.over?.id as LeadStage | undefined;
    const lead = optimistic.find((l) => l.id === id);
    if (!lead || !stage || lead.stage === stage) return;

    let lostReason: string | undefined;
    if (stage === "lost") {
      const reason = window.prompt("Why was this lead lost?");
      if (reason === null) return;
      lostReason = reason;
    }
    setError(null);
    startTransition(async () => {
      moveOptimistic({ id, stage });
      const res = await changeStageAction(id, stage, lostReason);
      if (res.error) setError(res.error);
    });
  }

  return (
    <>
      {error && <p className="mx-4 mb-2 rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
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
            />
          ))}
        </div>
      </DndContext>
    </>
  );
}

function Column({ id, label, hint, leads }: { id: LeadStage; label: string; hint: string; leads: BoardLead[] }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      data-stage={id}
      aria-label={label}
      className={`flex w-64 shrink-0 flex-col rounded-lg border bg-gray-100/80 ${isOver ? "border-brand ring-2 ring-brand/20" : "border-gray-200"}`}
    >
      <header className="flex items-baseline justify-between px-3 pt-3 pb-2" title={hint}>
        <h2 className="text-sm font-semibold text-gray-800">{label}</h2>
        <span className="text-xs text-gray-500">{leads.length}</span>
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
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 font-medium ${TRADE_COLORS[lead.trade]}`}>{tradeLabel(lead.trade)}</span>
        <span className="text-gray-400">{timeAgo(lead.stageChangedAt)}</span>
        {lead.assignee ? (
          <span
            title={lead.assignee}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[10px] font-semibold text-white"
          >
            {initials(lead.assignee)}
          </span>
        ) : (
          <span className="ml-auto text-gray-400">Unassigned</span>
        )}
      </div>
    </div>
  );
}

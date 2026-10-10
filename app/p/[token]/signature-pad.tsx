"use client";

import { useEffect, useRef, useState } from "react";
import { signatureFont } from "@/components/proposal/signature-font";

export type SignatureValue = { type: "drawn"; dataUrl: string } | { type: "typed"; text: string };

/** Draw with a finger/mouse, or type a name that's adopted as the signature. */
export function SignaturePad({ name, onChange }: { name: string; onChange: (v: SignatureValue | null) => void }) {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState(name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const strokes = useRef(0);
  const last = useRef<{ x: number; y: number } | null>(null);

  // Size the canvas for crisp lines on high-density screens; redo it when an iPad rotates (while still blank).
  useEffect(() => {
    if (mode !== "draw") return;
    const setup = () => {
      const c = canvas.current;
      if (!c) return;
      const ratio = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      c.width = Math.round(rect.width * ratio);
      c.height = Math.round(rect.height * ratio);
      const ctx = c.getContext("2d")!;
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#111827";
      strokes.current = 0;
      onChange(null);
    };
    setup();
    const onResize = () => {
      if (strokes.current === 0) setup();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mode, onChange]);

  useEffect(() => {
    if (mode === "type") onChange(typed.trim().length >= 2 ? { type: "typed", text: typed.trim() } : null);
  }, [mode, typed, onChange]);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function exportImage() {
    const c = canvas.current!;
    // Export at a modest size: plenty for a PDF, small to upload.
    const out = document.createElement("canvas");
    out.width = 600;
    out.height = Math.round((600 * c.height) / c.width);
    out.getContext("2d")!.drawImage(c, 0, 0, out.width, out.height);
    onChange({ type: "drawn", dataUrl: out.toDataURL("image/png") });
  }

  /** Ends a stroke on lift, and also when the OS interrupts it (scroll, palm rejection, notification). */
  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (strokes.current > 5) exportImage();
  }

  function clear() {
    const c = canvas.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    strokes.current = 0;
    onChange(null);
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="label mb-0">Your signature</span>
        <div className="flex gap-3 text-sm">
          <button type="button" className={mode === "draw" ? "font-semibold text-brand" : "text-gray-500 underline"} onClick={() => setMode("draw")}>
            Draw
          </button>
          <button type="button" className={mode === "type" ? "font-semibold text-brand" : "text-gray-500 underline"} onClick={() => setMode("type")}>
            Type
          </button>
        </div>
      </div>
      {mode === "draw" ? (
        <div className="relative">
          <canvas
            ref={canvas}
            aria-label="Signature pad: draw your signature"
            className="h-40 w-full touch-none rounded-md border-2 border-dashed border-gray-300 bg-white md:h-56"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              last.current = point(e);
            }}
            onPointerMove={(e) => {
              if (!drawing.current || !last.current) return;
              const ctx = e.currentTarget.getContext("2d")!;
              const p = point(e);
              ctx.beginPath();
              ctx.moveTo(last.current.x, last.current.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              last.current = p;
              strokes.current++;
            }}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onLostPointerCapture={endStroke}
          />
          <span className="pointer-events-none absolute bottom-2 left-3 text-sm text-gray-500">Sign here with your finger or mouse</span>
          <button type="button" className="absolute top-1 right-1 min-h-11 rounded-md px-3 text-sm text-gray-600 underline hover:bg-gray-100" onClick={clear}>
            Clear
          </button>
        </div>
      ) : (
        <div>
          <label className="sr-only" htmlFor="typed-signature">
            Type your name as your signature
          </label>
          <input id="typed-signature" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={100} />
          <div className="mt-2 flex h-20 items-end rounded-md border-2 border-dashed border-gray-300 bg-white px-4 pb-2">
            <span className={`${signatureFont.className} text-4xl leading-none`} aria-label="Signature preview">
              {typed}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

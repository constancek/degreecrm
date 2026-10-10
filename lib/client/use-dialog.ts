"use client";

import { useEffect, useEffectEvent, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal keyboard behavior: focus moves into the panel on open, Tab stays inside it, Escape closes,
 * and focus goes back to whatever had it (e.g. the dragged card) when the dialog unmounts.
 */
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    const panel = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const items = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    // Prefer the first form field; otherwise the first control.
    (panel?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea") ?? items()[0] ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const list = items();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return ref;
}

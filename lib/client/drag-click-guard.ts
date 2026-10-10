// After a drag ends the pointer is still over the dragged card, so the browser fires a click on its link.
// Boards call `markDragged()` on drag start/end and links call `suppressClickAfterDrag` in onClick.

let suppressUntil = 0;

export function markDragged() {
  suppressUntil = Date.now() + 400;
}

export function suppressClickAfterDrag(e: { preventDefault(): void }) {
  if (Date.now() < suppressUntil) e.preventDefault();
}

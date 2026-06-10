/**
 * Cross-browser guard that suppresses native text selection while a custom
 * pointer-driven drag is in progress (floating ball, split resizer,
 * region select, trail pan, ...).
 *
 * Chrome cancels native selection when a pointerdown is preventDefault()ed,
 * but Safari and Firefox do not — a drag on a custom control also drags out
 * a text selection underneath, which then triggers the TextSelectionManager
 * machinery (endOfContent expansion, DOM shuffling) mid-drag. Toggling
 * user-select on <body> is the one mechanism all three engines respect.
 *
 * Reference-counted so overlapping drags (e.g. pointercancel races) can't
 * strand the class on <body>.
 */

let activeDrags = 0;

/** Call when a custom drag starts (pointerdown). */
export function beginDragGuard() {
  if (++activeDrags === 1) {
    document.body.classList.add("ui-dragging");
    // Collapse any selection that snuck in before the guard (Safari starts
    // the native selection gesture even on a cancelled pointerdown).
    document.getSelection()?.removeAllRanges();
  }
}

/** Call when the drag ends (pointerup / pointercancel). Must pair with beginDragGuard. */
export function endDragGuard() {
  if (activeDrags > 0 && --activeDrags === 0) {
    document.body.classList.remove("ui-dragging");
  }
}

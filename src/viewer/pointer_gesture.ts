/**
 * Pointer gesture ownership — the single place that decides who drives a
 * gesture: the browser's native selection machinery, or our own code.
 *
 * `preventDefault()` on `pointerdown` cancels the native text-selection
 * gesture only in Blink; WebKit and Gecko start it from the default action of
 * the following `mousedown` (announced by `selectstart`). The `ui-dragging`
 * class is the complement: `user-select: none` is the only lever for pointer
 * types with no compatibility mouse events (touch, pen), but it cannot abort a
 * selection WebKit has already armed.
 *
 * Which to call:
 *   custom drag — control, handle, resizer, pan, drawing, region select
 *     -> beginDragGesture(), or onPointerDrag() for the common drag shape
 *   selection we compute in JS (viewpane's nearest-span selection)
 *     -> beginCustomSelectionGesture(); the `user-select: none` blanket is
 *        omitted, since it would block our own programmatic ranges
 *   native browser selection (pointerdown on a .textLayer span)
 *     -> claim nothing; TextSelectionManager constrains it via endOfContent
 *
 * Both claim functions must be called synchronously from `pointerdown` — the
 * last point that precedes `mousedown` on every engine. Each returns an
 * idempotent `release()` that also fires on pointerup/pointercancel/blur, so a
 * missed release cannot strand the document.
 */

/** Claims that suppress the engine's own selection for this gesture. */
let nativeClaims = 0;
/** Claims that additionally forbid any selection at all. */
let unselectableClaims = 0;

const swallow = (e: Event) => e.preventDefault();

function suppressNativeSelection() {
  if (++nativeClaims === 1) {
    // mousedown is the lever WebKit and Gecko actually respect; selectstart
    // catches gestures that reach the engine by another path.
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("selectstart", swallow, true);
  }
}

function restoreNativeSelection() {
  if (nativeClaims > 0 && --nativeClaims === 0) {
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("selectstart", swallow, true);
  }
}

/**
 * Wrap an undo function so it runs at most once, and also runs if the gesture
 * dies without the caller noticing.
 */
function makeRelease(undo: () => void): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    window.removeEventListener("blur", release);
    undo();
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", release);
  return release;
}

/**
 * Claim a gesture for a custom drag. Nothing may be selected until release.
 *
 * @returns release
 */
export function beginDragGesture(): () => void {
  suppressNativeSelection();
  if (++unselectableClaims === 1) {
    document.body.classList.add("ui-dragging");
  }
  // Collapse anything the engine started before the claim landed.
  document.getSelection()?.removeAllRanges();

  return makeRelease(() => {
    restoreNativeSelection();
    if (unselectableClaims > 0 && --unselectableClaims === 0) {
      document.body.classList.remove("ui-dragging");
    }
  });
}

/**
 * Claim a gesture whose selection we compute ourselves. The engine's own
 * selection is suppressed; programmatic ranges stay possible.
 *
 * @returns release
 */
export function beginCustomSelectionGesture(): () => void {
  suppressNativeSelection();
  return makeRelease(restoreNativeSelection);
}

export interface PointerDragOptions {
  onMove?: (e: PointerEvent) => void;
  onEnd?: (e: PointerEvent) => void;
  /**
   * Capture target; defaults to the handler's element. Pass `null` where
   * capture would get in the way — it retargets `click` to the capturing
   * element, past any handler on a descendant.
   */
  target?: Element | null;
}

/**
 * The common drag shape: claim the gesture, route the rest of it to `target`
 * via pointer capture, and guarantee teardown on every terminal path.
 *
 * `onEnd` always receives a PointerEvent — the last one seen, if the gesture
 * died on blur rather than pointerup.
 *
 * @param event pointerdown that starts the drag
 * @returns end — ends the drag now; `onEnd` still runs
 */
export function onPointerDrag(
  event: PointerEvent,
  { onMove, onEnd, target }: PointerDragOptions = {},
): () => void {
  const release = beginDragGesture();
  const { pointerId } = event;
  const captureTarget =
    target === undefined
      ? event.currentTarget instanceof Element
        ? event.currentTarget
        : null
      : target;

  try {
    captureTarget?.setPointerCapture(pointerId);
  } catch {
    // Pointer already gone (very fast click) — the document listeners still run.
  }

  let lastEvent = event;
  let done = false;

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    lastEvent = e;
    onMove?.(e);
  };

  const finish = (e?: Event) => {
    if (done) return;
    const pe = e as PointerEvent | undefined;
    if (pe?.pointerId !== undefined && pe.pointerId !== pointerId) return;
    done = true;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    try {
      captureTarget?.releasePointerCapture(pointerId);
    } catch {
      // Capture already released.
    }
    release();
    onEnd?.(pe?.pointerId !== undefined ? pe : lastEvent);
  };

  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);

  return finish;
}

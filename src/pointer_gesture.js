/**
 * Pointer gesture ownership — the single place that decides who drives a
 * gesture: the browser's native selection machinery, or our own code.
 *
 * WHY THIS EXISTS
 * ---------------
 * `preventDefault()` on `pointerdown` cancels the native text-selection
 * gesture **only in Blink**. WebKit and Gecko dispatch `pointerdown` as an
 * observer event: the selection is started by the default action of the
 * following `mousedown` (and announced by `selectstart`). So code that calls
 * `e.preventDefault()` in a `pointerdown` handler and assumes "no native
 * selection will happen" is silently Chrome-only — in Safari the native
 * selection runs *in parallel* with whatever the handler implements.
 *
 * Toggling `user-select` on <body> (the `ui-dragging` class) is the other
 * half: it is the only mechanism all three engines respect for pointer types
 * that have no compatibility mouse events (touch, pen). It cannot replace the
 * mousedown lever — in WebKit `user-select: none` stops a selection from
 * starting, it does not abort one the engine has already armed.
 *
 * DECISION TREE — which one do I call?
 * ------------------------------------
 *   The gesture starts a custom drag (control, handle, resizer, pan, drawing,
 *   region select)?
 *     -> beginDragGesture(), or onPointerDrag() for the common drag shape.
 *        Nothing may be selected for the whole gesture.
 *
 *   The gesture drives a selection that *we* compute in JS (viewpane's
 *   nearest-span selection)?
 *     -> beginCustomSelectionGesture(). The engine must not run its own
 *        selection, but programmatic ranges must still work, so the
 *        `user-select: none` blanket is NOT applied.
 *
 *   The gesture lets the browser select text natively (pointerdown landing on
 *   a .textLayer span)?
 *     -> Claim nothing. TextSelectionManager constrains it via endOfContent.
 *
 * Both claim functions must be called synchronously from the `pointerdown`
 * handler — the only point that still precedes `mousedown` on every engine.
 * Each returns a `release()`; calling it twice is safe, and the claim
 * self-releases on pointerup/pointercancel/blur, so a missed release can never
 * strand the document in a non-interactive state.
 */

/** Claims that suppress the engine's own selection for this gesture. */
let nativeClaims = 0;
/** Claims that additionally forbid any selection at all. */
let unselectableClaims = 0;

const swallow = (e) => e.preventDefault();

function suppressNativeSelection() {
  if (++nativeClaims === 1) {
    // mousedown: cancelling its default action is what actually stops WebKit
    // and Gecko from starting a selection. selectstart: an independent belt
    // for gestures that reach the engine by another path.
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
 * @param {() => void} undo
 * @returns {() => void} release
 */
function makeRelease(undo) {
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
 * @returns {() => void} release
 */
export function beginDragGesture() {
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
 * @returns {() => void} release
 */
export function beginCustomSelectionGesture() {
  suppressNativeSelection();
  return makeRelease(restoreNativeSelection);
}

/**
 * The common drag shape: claim the gesture, route the rest of it to `target`
 * via pointer capture, and guarantee teardown on every terminal path.
 *
 * `onEnd` always receives a PointerEvent — the last one seen, if the gesture
 * died on blur rather than pointerup.
 *
 * @param {PointerEvent} event pointerdown that starts the drag
 * @param {object} [opts]
 * @param {(e: PointerEvent) => void} [opts.onMove]
 * @param {(e: PointerEvent) => void} [opts.onEnd]
 * @param {Element} [opts.target] capture target; defaults to the handler's element
 * @returns {() => void} cancel — ends the drag early
 */
export function onPointerDrag(event, { onMove, onEnd, target } = {}) {
  const release = beginDragGesture();
  const { pointerId } = event;
  const captureTarget =
    target ??
    (event.currentTarget instanceof Element ? event.currentTarget : null);

  try {
    captureTarget?.setPointerCapture(pointerId);
  } catch {
    // Pointer already gone (very fast click) — the document listeners still run.
  }

  let lastEvent = event;
  let done = false;

  const move = (e) => {
    if (e.pointerId !== pointerId) return;
    lastEvent = e;
    onMove?.(e);
  };

  const finish = (e) => {
    if (done) return;
    if (e?.pointerId !== undefined && e.pointerId !== pointerId) return;
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
    onEnd?.(e?.pointerId !== undefined ? e : lastEvent);
  };

  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);

  return finish;
}

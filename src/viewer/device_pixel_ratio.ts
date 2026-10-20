/**
 * Call `onChange` a frame after devicePixelRatio changes — the window moved
 * to a display with a different density, or browser zoom changed. Moving
 * between displays doesn't always fire `resize`, so this is the only signal
 * some of those changes give. A `resolution` query only matches one ratio,
 * so it is re-armed for the new one on every change.
 *
 * Returns a function that stops watching.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  let raf: number | null = null;

  const handle = () => {
    arm();
    raf = requestAnimationFrame(() => {
      raf = null;
      onChange();
    });
  };

  const arm = () => {
    unwatch();
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", handle, { once: true });
  };

  const unwatch = () => {
    query?.removeEventListener("change", handle);
    query = null;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };

  arm();
  return unwatch;
}

// The visible part of the screen. A phone keyboard shrinks the visual viewport and often leaves the page
// (layout viewport) at full height, so 100dvh runs under the keyboard. As v1 does (public/app.js
// fitViewport), the app keeps the visual viewport's height and offset in CSS custom properties, which
// Type uses to stay above the keyboard. Pinch zoom is left alone.

/** The custom properties for a visual viewport, or null to fall back to 100dvh. Pure. */
export function viewportVars(vv) {
  if (!vv || vv.scale > 1.01) return null;
  return { '--vv-h': `${Math.round(vv.height)}px`, '--vv-top': `${Math.max(0, Math.round(vv.offsetTop ?? 0))}px` };
}

/** Keeps the properties current on `root` while the visual viewport changes. Returns a stop function. */
export function watchViewport(win = globalThis.window) {
  const root = win?.document?.documentElement;
  if (!root) return () => {};
  const fit = () => {
    const vars = viewportVars(win.visualViewport);
    for (const k of ['--vv-h', '--vv-top']) {
      if (vars) root.style.setProperty(k, vars[k]);
      else root.style.removeProperty(k);
    }
  };
  fit();
  const vv = win.visualViewport;
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  return () => {
    vv?.removeEventListener('resize', fit);
    vv?.removeEventListener('scroll', fit);
  };
}

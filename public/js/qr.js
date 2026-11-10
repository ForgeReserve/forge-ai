// QR codes as crisp SVG (from the cashucard.org/fund kit), and NUT-16 animated QR codes (bc-ur
// fountain parts) for eCash tokens too long for one code. Libraries load on first use.
import { loadScript, prefersReducedMotion } from './ui.js';

const ensureQr = () => loadScript('/vendor/qrcode.js');
const ensureUr = () => loadScript('/vendor/bcur.js');

function svgFor(text, level) {
  const qr = window.qrcode(0, level || 'M');
  const upper = /^[0-9A-Z $%*+\-./:]*$/.test(text);
  qr.addData(text, upper ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 2;
  const size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path fill="#0b0d10" d="${d}"/></svg>`;
}

/** Renders one QR code into `box`. */
export async function renderQR(box, text, level = 'M') {
  await ensureQr();
  box.innerHTML = svgFor(text, level);
  box.classList.remove('loading');
}

/** Longest text we put into a single code; past this phones struggle to read it. */
export const STATIC_MAX = 700;

/**
 * Plays an animated NUT-16 code into `box` until stop() is called. Wallets that scan animated
 * Cashu codes (cashu.me, Minibits, Macadamia, ...) assemble the parts in any order.
 */
export async function playAnimatedQR(box, text, { fragment = 180, fps = 6 } = {}) {
  await Promise.all([ensureQr(), ensureUr()]);
  const enc = window.BCUR.encoder(text, fragment);
  let stopped = false;
  const frame = () => {
    if (stopped) return;
    box.innerHTML = svgFor(enc.next(), 'L');
  };
  frame();
  box.classList.remove('loading');
  // Still animates with reduced motion (the parts are the data), just more slowly.
  const timer = setInterval(frame, 1000 / (prefersReducedMotion() ? Math.min(fps, 3) : fps));
  return {
    parts: enc.count(),
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

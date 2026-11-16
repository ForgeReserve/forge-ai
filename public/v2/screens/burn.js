// Hold to burn (owner, 2026-11-15): a burn is never one tap. Holding the button sets the card on fire
// from its bottom edge: a glowing front with flame tongues climbs it, embers rise, and what it passes is
// charred. Let go early and the fire dies back and the card recovers; hold to the end (about 1.7 s) and
// the charred card curls back and falls away as ash, then the burn happens.
//
// Drawn on one canvas fixed over the viewport (never the size of a long card), clipped to the part of the
// card in view, with plain fills and strokes and no shadow blur; the card itself only takes transform,
// opacity and filter changes, on its own layer. With reduced motion there is no fire: the button fills
// like a bar, and the burn happens when it is full. A short haptic tick marks the hold on phones that
// have it (core/adapters.js haptics).
import { adapters } from '../core/adapters.js';
import { reduced } from '../core/ui.js';

export const BURN_MS = 1700;
const RECOVER_MS = 420;
const FINALE_MS = 700;
const TAP_MS = 260;

/** A smooth wobble along the fire's front, in px, for x (px) at time t (s). */
const wobble = (x, t) => 9 * Math.sin(x * 0.034 + t * 1.9) + 5 * Math.sin(x * 0.087 - t * 2.6) + 2.4 * Math.sin(x * 0.21 + t * 5.1);
const ease = (p) => p * p * (3 - 2 * p);

/**
 * Turns `btn` into a hold-to-burn button.
 * target(): the element that burns (the conversation card), read when the hold starts.
 * onBurn(): called once the hold completes (after the ash), awaited.
 * onTap(): a press too short to be a hold (say "Hold to burn").
 * below(): an element pinned over the card's foot (the answer's dock): the fire stays above it.
 * Returns {destroy()}.
 */
export function holdToBurn(btn, { target, onBurn, onTap = () => {}, ms = BURN_MS, below = null }) {
  btn.classList.add('hold-burn');
  const fill = document.createElement('span');
  fill.className = 'hold-fill';
  fill.setAttribute('aria-hidden', 'true');
  btn.prepend(fill);

  let p = 0; // 0 to 1: how far the fire has climbed
  let phase = 'idle'; // idle, holding, recover, finale, done
  let last = 0;
  let downAt = 0;
  let raf = 0;
  let fx = null; // the fire's canvas, while it burns
  let card = null;
  let ticked = 0;

  const setP = (v) => {
    p = Math.max(0, Math.min(1, v));
    btn.style.setProperty('--hold', p.toFixed(3));
    if (card && !reduced()) {
      const e = ease(p);
      card.style.setProperty('--burn', e.toFixed(3));
    }
  };

  const start = () => {
    if (phase === 'finale' || phase === 'done') return;
    downAt = performance.now();
    if (phase === 'idle') {
      card = target?.() ?? null;
      if (card && !reduced()) {
        card.classList.add('burning');
        fx ??= createFire(below);
      }
    }
    phase = 'holding';
    btn.classList.add('holding');
    last = performance.now();
    ticked = 0;
    raf ||= requestAnimationFrame(frame);
  };

  const release = () => {
    if (phase !== 'holding') return;
    btn.classList.remove('holding');
    if (performance.now() - downAt < TAP_MS && p < 0.2) onTap();
    phase = 'recover';
    last = performance.now();
    raf ||= requestAnimationFrame(frame);
  };

  const finish = async () => {
    phase = 'finale';
    btn.classList.remove('holding');
    adapters.haptics.pulse([18, 40, 28]);
    if (card && fx && !reduced()) {
      fx.burst(card);
      // The char on the canvas gives way to the card's own: it is near black from here, and it is the
      // card that curls back and falls away, while the canvas keeps its embers and ash.
      fx.finale();
      const loop = (now) => {
        if (phase !== 'finale' || !fx) return;
        fx.draw(card, 1, now);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      // It turns about the middle of the part in view (a long card reaches far below the screen).
      const r = card.getBoundingClientRect();
      const mid = Math.max(0, -r.top) + (Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)) / 2;
      card.style.transformOrigin = `50% ${Math.round(mid)}px`;
      const anim = card.animate(
        [
          { transform: 'perspective(900px) rotateX(-7deg) translateY(0) scale(0.98)', opacity: 1, filter: 'brightness(0.08) sepia(0.6) blur(0px)' },
          { transform: 'perspective(900px) rotateX(-22deg) translateY(-14px) scale(0.92)', opacity: 0.8, filter: 'brightness(0.05) sepia(0.3) blur(0.6px)', offset: 0.45 },
          { transform: 'perspective(900px) rotateX(-55deg) translateY(-40px) scale(0.72)', opacity: 0, filter: 'brightness(0.03) sepia(0) blur(3px)' },
        ],
        { duration: FINALE_MS, easing: 'cubic-bezier(.55, 0, .7, .4)', fill: 'forwards' },
      );
      await anim.finished.catch(() => {});
    }
    phase = 'done';
    try {
      await onBurn();
    } finally {
      // The ash keeps drifting over whatever screen comes next, then the canvas goes.
      fx?.fadeOut(() => (fx = null));
    }
  };

  function frame(now) {
    raf = 0;
    const dt = Math.min(64, now - last);
    last = now;
    if (phase === 'holding') {
      setP(p + dt / ms);
      // A light tick every quarter of the hold.
      const q = Math.floor(p * 4);
      if (q > ticked) {
        ticked = q;
        adapters.haptics.pulse(8);
      }
      if (p >= 1) {
        fx?.draw(card, 1, now);
        finish();
        return;
      }
    } else if (phase === 'recover') {
      setP(p - dt / RECOVER_MS);
      if (p <= 0) {
        phase = 'idle';
        card?.classList.remove('burning');
        card?.style.removeProperty('--burn');
        card = null;
      }
    }
    if (fx) fx.draw(card, ease(p), now);
    if (phase === 'holding' || phase === 'recover' || (fx && fx.alive())) raf = requestAnimationFrame(frame);
    else if (phase === 'idle' && fx) {
      fx.remove();
      fx = null;
    }
  }

  const onDown = (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    start();
  };
  const onKey = (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      if (e.type === 'keydown') start();
      else release();
    }
  };
  // A click with no press before it (a screen reader's activation): say how it works.
  const onClick = (e) => {
    if (e.detail === 0 && phase === 'idle') onTap();
  };
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('keydown', onKey);
  btn.addEventListener('keyup', onKey);
  btn.addEventListener('click', onClick);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (phase !== 'done') fx?.remove();
    },
  };
}

/**
 * The fire: a canvas fixed over the viewport. draw(card, e, now) paints the fire at height e (0 to 1)
 * over the card's visible part; burst(card) throws the last embers and the ash; fadeOut(done) lets the
 * ash drift, then removes the canvas.
 */
function createFire(below = null) {
  const cv = document.createElement('canvas');
  cv.className = 'burn-fx';
  cv.setAttribute('aria-hidden', 'true');
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0;
  let H = 0;
  const size = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  };
  size();
  const sparks = []; // {x, y, vx, vy, life, max, r, ash}
  let lastT = performance.now();
  let fading = 0;
  let onGone = null;
  let removed = false;
  let charFrom = 0; // when the finale began: the canvas's char fades as the card's own takes over

  /** The part of the card in view, with its corner radius. */
  const rectOf = (card) => {
    const r = card.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const foot = below?.()?.getBoundingClientRect().top;
    const bottom = Math.min(r.bottom, H, foot != null ? foot + 14 : H);
    if (bottom <= top) return null;
    const rad = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
    return { left: r.left, right: r.right, top, bottom, w: r.width, h: bottom - top, rad, fullTop: r.top, fullBottom: r.bottom };
  };

  const roundRect = (R) => {
    ctx.beginPath();
    // Round only the corners that are in view.
    const tl = R.fullTop >= R.top - 0.5 ? R.rad : 0;
    const bl = R.fullBottom <= R.bottom + 0.5 ? R.rad : 0;
    ctx.roundRect(R.left, R.top, R.w, R.h, [tl, tl, bl, bl]);
  };

  /** The front's line across the card at height y (px), as points every 8 px. */
  const frontLine = (R, y, t) => {
    const pts = [];
    for (let x = R.left - 8; x <= R.right + 8; x += 8) pts.push([x, y + wobble(x - R.left, t)]);
    return pts;
  };
  const trace = (pts, dy = 0) => {
    ctx.moveTo(pts[0][0], pts[0][1] + dy);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      ctx.quadraticCurveTo(x0, y0 + dy, (x0 + x1) / 2, (y0 + y1) / 2 + dy);
    }
  };

  function step(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      s.vy += (s.ash ? 26 : -18) * dt;
      s.vx += Math.sin(s.life * 6 + s.seed) * 30 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
    }
  }

  function drawSparks() {
    ctx.globalCompositeOperation = 'lighter';
    for (const s of sparks) {
      if (s.ash) continue;
      const a = Math.min(1, s.life / s.max) * (1 - fading);
      const k = s.life / s.max;
      ctx.fillStyle = k > 0.6 ? `rgba(255,236,170,${a})` : k > 0.3 ? `rgba(255,170,60,${a})` : `rgba(240,90,30,${a * 0.9})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * (0.6 + 0.4 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const s of sparks) {
      if (!s.ash) continue;
      const a = Math.min(1, s.life / s.max) * 0.85 * (1 - fading);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.fillStyle = s.glow > 0 && s.life > s.max - s.glow ? `rgba(255,140,60,${a})` : `rgba(${s.tone},${s.tone},${s.tone - 6},${a})`;
      ctx.fillRect(-s.r, -s.r * 0.55, s.r * 2, s.r * 1.1);
      ctx.restore();
    }
  }

  return {
    alive: () => !removed && sparks.length > 0,
    draw(card, e, now) {
      if (removed) return;
      if (cv.width !== Math.round(window.innerWidth * dpr)) size();
      const dt = Math.min(0.064, (now - lastT) / 1000);
      lastT = now;
      const t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      step(dt);
      const R = card && card.isConnected ? rectOf(card) : null;
      const charA = charFrom ? Math.max(0, 1 - (now - charFrom) / 180) : 1;
      if (R && e > 0.001 && charA > 0) {
        // The front climbs from below the bottom edge to past the top, so the whole card chars at 1.
        const y = R.bottom + 26 - e * (R.h + 64);
        const pts = frontLine(R, y, t);
        ctx.save();
        ctx.globalAlpha = charA;
        roundRect(R);
        ctx.clip();
        // Scorch: the card browns ahead of the fire.
        const scorch = ctx.createLinearGradient(0, y - 70, 0, y);
        scorch.addColorStop(0, 'rgba(90,48,14,0)');
        scorch.addColorStop(1, 'rgba(90,48,14,0.42)');
        ctx.fillStyle = scorch;
        ctx.beginPath();
        trace(pts, -70);
        ctx.lineTo(R.right + 8, y);
        ctx.lineTo(R.left - 8, y);
        ctx.closePath();
        ctx.fill();
        // Char: everything the front has passed, near black with a little warmth, mottled.
        ctx.beginPath();
        trace(pts);
        ctx.lineTo(R.right + 8, R.bottom + 40);
        ctx.lineTo(R.left - 8, R.bottom + 40);
        ctx.closePath();
        const char = ctx.createLinearGradient(0, y, 0, R.bottom);
        char.addColorStop(0, 'rgba(34,14,8,0.97)');
        char.addColorStop(0.18, 'rgba(16,10,9,0.97)');
        char.addColorStop(1, 'rgba(10,9,9,0.98)');
        ctx.fillStyle = char;
        ctx.fill();
        // Embers still alive in the char: a few dim red spots that breathe.
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 9; i++) {
          const ex = R.left + ((i * 97.3 + 31) % R.w);
          const ey = y + 18 + ((i * 53.9) % Math.max(20, R.bottom - y));
          if (ey > R.bottom) continue;
          const a = 0.1 + 0.08 * Math.sin(t * 3 + i * 1.7);
          ctx.fillStyle = `rgba(200,60,20,${a})`;
          ctx.beginPath();
          ctx.ellipse(ex, ey, 10 + (i % 3) * 4, 3 + (i % 2) * 2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // The burning edge: a red-hot rim, then the glow in three passes, widest and faintest first.
        for (const [w, c] of [
          [30, 'rgba(255,110,30,0.16)'],
          [15, 'rgba(255,150,50,0.32)'],
          [6, 'rgba(255,214,120,0.85)'],
          [2.2, 'rgba(255,248,225,0.95)'],
        ]) {
          ctx.lineWidth = w;
          ctx.strokeStyle = c;
          ctx.beginPath();
          trace(pts);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = 7;
        ctx.strokeStyle = 'rgba(110,24,8,0.7)';
        ctx.beginPath();
        trace(pts, 7);
        ctx.stroke();
        // Flame tongues along the front, flickering.
        ctx.globalCompositeOperation = 'lighter';
        const n = Math.max(6, Math.round(R.w / 24));
        for (let i = 0; i < n; i++) {
          const fx0 = R.left + ((i + 0.5) / n) * R.w + 4 * Math.sin(t * 2.1 + i);
          const fy = y + wobble(fx0 - R.left, t);
          const hgt = (16 + 12 * Math.sin(t * 7.3 + i * 1.9) + 8 * Math.sin(t * 13.1 + i * 0.7)) * (0.55 + 0.45 * Math.min(1, e * 4));
          const half = 5 + 2 * Math.sin(t * 5 + i);
          const g = ctx.createLinearGradient(0, fy, 0, fy - hgt);
          g.addColorStop(0, 'rgba(255,224,140,0.85)');
          g.addColorStop(0.45, 'rgba(255,140,40,0.55)');
          g.addColorStop(1, 'rgba(230,60,20,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(fx0 - half, fy + 2);
          ctx.quadraticCurveTo(fx0 - half * 0.9, fy - hgt * 0.5, fx0 + 1.5 * Math.sin(t * 9 + i), fy - hgt);
          ctx.quadraticCurveTo(fx0 + half * 0.9, fy - hgt * 0.5, fx0 + half, fy + 2);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
        // New embers from the front, more as it burns harder.
        const want = dt * (40 + 70 * e) * (R.w / 360);
        for (let i = 0; i < want && sparks.length < 220; i++) {
          const sx = R.left + Math.random() * R.w;
          const sy = y + wobble(sx - R.left, t) - 2;
          if (sy < R.top - 10 || sy > R.bottom + 10) continue;
          const max = 0.55 + Math.random() * 0.7;
          sparks.push({ x: sx, y: sy, vx: (Math.random() - 0.5) * 40, vy: -40 - Math.random() * 70, life: max, max, r: 0.8 + Math.random() * 1.6, ash: false, seed: Math.random() * 9, rot: 0, spin: 0 });
        }
      }
      ctx.globalAlpha = 1;
      drawSparks();
    },
    finale() {
      charFrom = performance.now();
    },
    /** The last of the fire: a shower of embers and ash flakes from the card as it falls away. */
    burst(card) {
      const R = card?.isConnected ? rectOf(card) : null;
      if (!R) return;
      const n = Math.min(140, Math.round((R.w * R.h) / 900));
      for (let i = 0; i < n; i++) {
        const ash = i % 3 !== 0;
        const max = ash ? 0.9 + Math.random() * 0.9 : 0.4 + Math.random() * 0.6;
        sparks.push({
          x: R.left + Math.random() * R.w,
          y: R.top + Math.random() * R.h,
          vx: (Math.random() - 0.5) * 90,
          vy: ash ? -60 - Math.random() * 80 : -90 - Math.random() * 90,
          life: max,
          max,
          r: ash ? 1.6 + Math.random() * 2.6 : 0.8 + Math.random() * 1.4,
          ash,
          tone: 70 + Math.round(Math.random() * 60),
          glow: ash && Math.random() < 0.35 ? 0.25 : 0,
          seed: Math.random() * 9,
          rot: Math.random() * 6,
          spin: (Math.random() - 0.5) * 8,
        });
      }
    },
    fadeOut(done) {
      onGone = done;
      const begin = performance.now();
      const tick = (now) => {
        if (removed) return;
        fading = Math.min(1, Math.max(0, (now - begin - 500) / 600));
        this.draw(null, 0, now);
        if (fading < 1 && sparks.length) requestAnimationFrame(tick);
        else this.remove();
      };
      requestAnimationFrame(tick);
    },
    remove() {
      if (removed) return;
      removed = true;
      cv.remove();
      onGone?.();
    },
  };
}

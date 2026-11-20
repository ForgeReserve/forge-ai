// The pictures on the wallet cards (AddFunds-C1 to C4 in docs/design/canvas), drawn to the first run's
// standard (screens/firstrun-art.js, C-Welcome to C-Private): one light for every picture, a key light from
// the top left and a soft teal rim light from the bottom right, layered gradients for volume, specular
// highlights and soft contact shadows, and real materials: a gift box for Start free, a printed paper note
// seen close (the code that holds the money in the camera's frame, the banknote running off to the left), a
// lit Lightning bolt, the Cashu card and the Fedimint card each at a phone (their printed faces, from
// screens/brands/cards.js), the C-Pay coin for eCash, and for the More ways a coin swap, a bitcoin coin and
// a free-question voucher.
//
// The markup is static and from this file only (built from numbers here, never from data). Every drawing
// gets its own id prefix, so two pictures on one screen never share a gradient or a filter.
import { dash, dashAfter } from '../core/rings.js';
import { el, icon } from '../core/ui.js';
import { cashuFace, fedimintFace } from './brands/cards.js';

const NS = 'http://www.w3.org/2000/svg';
const TEAL = '#3FCFB4';

let n = 0;
const prefix = () => `wa${++n}-`;

/** An inline SVG from static markup in this file. */
function svg(markup, { w, h, box, label = null, cls = '' }) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('width', String(w));
  s.setAttribute('height', String(h));
  s.setAttribute('viewBox', box);
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  // No whitespace between the tags, so a button's text is only its word.
  s.innerHTML = markup.replace(/>\s+</g, '><').trim();
  return s;
}

// ------------------------------------------------------------------ shared defs

/** A linear gradient: stops as [offset, colour, opacity?]. */
const lg = (id, [x1, y1, x2, y2], stops, user = false) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${user ? ' gradientUnits="userSpaceOnUse"' : ''}>${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</linearGradient>`;
/** A radial gradient, with an optional focus (fx, fy) for the key light. */
const rg = (id, { cx = '50%', cy = '50%', r = '50%', fx = null, fy = null }, stops) =>
  `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"${fx ? ` fx="${fx}" fy="${fy}"` : ''}>${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</radialGradient>`;
/** The blurs every drawing uses: b06, b1, b2, b4, b8; and paper grain. */
const filters = (p) =>
  [
    ['b06', 0.6],
    ['b1', 1],
    ['b2', 2],
    ['b4', 4],
    ['b8', 8],
  ]
    .map(([k, s]) => `<filter id="${p}${k}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${s}"/></filter>`)
    .join('') +
  `<filter id="${p}grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.9 0.7" numOctaves="2" seed="7" stitchTiles="stitch" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.4 0 0 0 -0.62" result="lt"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.4 0 0 0 0.78" result="dk"/><feMerge result="m"><feMergeNode in="lt"/><feMergeNode in="dk"/></feMerge><feComposite in="m" in2="SourceAlpha" operator="in"/></filter>`;
const f = (p, k) => `filter="url(#${p}${k})"`;

/** A soft contact shadow: a wide blurred ellipse and a tight dark one. */
const contact = (p, cx, cy, rx, ry, a = 0.35, ink = '#000000') =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry * 1.6}" fill="${ink}" opacity="${a * 0.6}" ${f(p, 'b4')}/><ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.78}" ry="${ry * 0.6}" fill="${ink}" opacity="${a}" ${f(p, 'b1')}/>`;

/** A four-point sparkle with its glow. */
const sparkle = (p, x, y, s, c = '#FFF4CF') =>
  `<circle cx="${x}" cy="${y}" r="${s * 1.1}" fill="${c}" opacity="0.45" ${f(p, 'b2')}/><path d="M${x} ${y - s}Q${x + s * 0.16} ${y - s * 0.16} ${x + s} ${y}Q${x + s * 0.16} ${y + s * 0.16} ${x} ${y + s}Q${x - s * 0.16} ${y + s * 0.16} ${x - s} ${y}Q${x - s * 0.16} ${y - s * 0.16} ${x} ${y - s}Z" fill="${c}"/>`;

// ------------------------------------------------------------------ the coin (as C-Pay draws it)

/** The coin's gradients, once per drawing. */
const coinDefs = (p) =>
  lg(`${p}edge`, [0, 0, 1, 0], [
    [0, '#7A5512'],
    [0.07, '#B8862C'],
    [0.19, '#F6D98E'],
    [0.28, '#DDAA48'],
    [0.55, '#A87A22'],
    [0.82, '#6B4A10'],
    [0.93, '#8F6A1E'],
    [1, '#5E410D'],
  ]) +
  lg(`${p}face`, [0.1, 0, 0.9, 1], [
    [0, '#FFF0BE'],
    [0.3, '#F2CF78'],
    [0.62, '#DDAE4E'],
    [1, '#B3802A'],
  ]) +
  lg(`${p}field`, [0.1, 0, 0.9, 1], [
    [0, '#E9C36A'],
    [0.5, '#D3A043'],
    [1, '#A97A24'],
  ]) +
  lg(`${p}wall`, [0, 0, 1, 1], [
    [0, '#5A3C08', 0.85],
    [0.5, '#9C7020', 0.4],
    [1, '#FFF2C8', 0.95],
  ]) +
  lg(`${p}emb`, [0, 0, 1, 1], [
    [0, '#FFF4CF'],
    [0.55, '#EAC46C'],
    [1, '#C49035'],
  ]);

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * One coin seen from above at an angle: rim with its milled edge, face with the raised field, the dotted
 * ring and the mark (the eCash star or a bitcoin B). (cx, cy) is the face's centre, rx its half width,
 * ry its half height, h the coin's thickness.
 */
function coin(p, { cx, cy, rx, ry, h, mark = 'star', rim = true }) {
  const k = rx / 44;
  const ridges = [];
  const lights = [];
  for (let i = 1; i < 44; i++) {
    const a = (Math.PI * i) / 44;
    const x = r1(cx + rx * Math.cos(a));
    const y = r1(cy + ry * Math.sin(a));
    ridges.push(`M${x} ${r1(y + 0.8)}V${r1(y + h - 0.6)}`);
    const a2 = (Math.PI * (i + 0.5)) / 44;
    lights.push(`M${r1(cx + rx * Math.cos(a2))} ${r1(cy + ry * Math.sin(a2) + 1)}V${r1(cy + ry * Math.sin(a2) + h - 0.4)}`);
  }
  const markPath =
    mark === 'btc'
      ? `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M-8 -16H5a8 8 0 0 1 0 16H-8V16H7a8 8 0 0 0 0-16M-8 -16V16M-3 -21V-16M4 -21V-16M-3 16V21M4 16V21" stroke="#5A3C08" stroke-opacity="0.55" stroke-width="5" transform="translate(1 1.6)"/><path d="M-8 -16H5a8 8 0 0 1 0 16H-8V16H7a8 8 0 0 0 0-16M-8 -16V16M-3 -21V-16M4 -21V-16M-3 16V21M4 16V21" stroke="url(#${p}emb)" stroke-width="4.4"/><path d="M-8 -16H5a8 8 0 0 1 0 16" stroke="#FFF6D8" stroke-opacity="0.7" stroke-width="1.2" transform="translate(-0.6 -1)"/></g>`
      : `<path d="M0 -17Q2.6 -2.6 17 0Q2.6 2.6 0 17Q-2.6 2.6 -17 0Q-2.6 -2.6 0 -17Z" fill="#5A3C08" opacity="0.55" transform="translate(1 1.6)"/><path d="M0 -17Q2.6 -2.6 17 0Q2.6 2.6 0 17Q-2.6 2.6 -17 0Q-2.6 -2.6 0 -17Z" fill="#FFF6D8" opacity="0.8" transform="translate(-0.7 -1.2)"/><path d="M0 -17Q2.6 -2.6 17 0Q2.6 2.6 0 17Q-2.6 2.6 -17 0Q-2.6 -2.6 0 -17Z" fill="url(#${p}emb)"/>`;
  return `<path d="M${cx - rx} ${cy}V${cy + h}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy + h}V${cy}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}Z" fill="url(#${p}edge)"/>
<path d="${ridges.join('')}" fill="none" stroke="#462E05" stroke-opacity="0.42" stroke-width="${r1(0.8 * Math.max(0.6, k))}"/>
<path d="${lights.join('')}" fill="none" stroke="#FFEBB0" stroke-opacity="0.22" stroke-width="${r1(0.6 * Math.max(0.6, k))}"/>
<path d="M${cx - rx} ${cy + h}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy + h}" fill="none" stroke="#3C2804" stroke-opacity="0.6" stroke-width="0.8"/>
<path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy}" fill="none" stroke="#FFE7A8" stroke-opacity="0.7" stroke-width="0.9"/>
${rim ? `<path d="M${cx + rx} ${cy + 1}V${cy + h - 1}A${rx} ${ry} 0 0 1 ${r1(cx + rx * 0.64)} ${r1(cy + h + ry * 0.77)}" fill="none" stroke="${TEAL}" stroke-opacity="0.6" stroke-width="1.3" ${f(p, 'b06')}/>` : ''}
<g transform="translate(${cx} ${cy}) scale(${r1(k * 100) / 100} ${r1((ry / rx) * k * 1000) / 1000})">
<circle r="44" fill="url(#${p}face)"/><circle r="37.5" fill="url(#${p}field)"/><circle r="37.5" fill="none" stroke="url(#${p}wall)" stroke-width="2"/>
<circle r="33.5" fill="none" stroke="#7A5614" stroke-opacity="0.55" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.01 3.5"/>
${markPath}
<circle r="22.5" fill="none" stroke="#FFF2C8" stroke-opacity="0.45" stroke-width="1"/>
<circle r="44" fill="none" stroke="#FFF4D2" stroke-opacity="0.8" stroke-width="1.4" stroke-dasharray="70 300" stroke-dashoffset="-150"/>
<ellipse cx="-17" cy="-20" rx="14" ry="7" fill="#FFFFFF" opacity="0.6" ${f(p, 'b2')}/>
</g>`;
}

// ------------------------------------------------------------------ the note's coin, with its dollar sign

/** The dollar coin's gradients: the raised rim, the sunk field, the wall between them and the sign. */
const dollarDefs = (p) =>
  rg(`${p}cn`, { fx: '32%', fy: '26%' }, [
    [0, '#FFF3C9'],
    [0.45, '#EBC56C'],
    [0.8, '#C29034'],
    [1, '#9C7020'],
  ]) +
  lg(`${p}cnf`, [0.15, 0, 0.85, 1], [
    [0, '#F0CD7E'],
    [0.5, '#DDAD4E'],
    [1, '#BD8A32'],
  ]) +
  lg(`${p}cnw`, [0.15, 0.1, 0.85, 0.9], [
    [0, '#5A3C08', 0.75],
    [0.5, '#8A6410', 0.25],
    [1, '#FFF2C8', 0.95],
  ]) +
  lg(`${p}cnr`, [0.1, 0.1, 0.9, 0.9], [
    [0, '#FFFFFF', 0.95],
    [0.45, '#FFFFFF', 0.08],
    [1, '#FFFFFF', 0],
  ]) +
  lg(`${p}usd`, [-7, -12, 7, 12], [
    [0, '#FFF8DE'],
    [0.5, '#F3D488'],
    [1, '#D2A045'],
  ], true);

// The dollar sign at 1 unit = 1 px of a 26 px coin: an S, and one vertical stroke through it whose
// tails show above and below. Centred on (0, 0).
const USD_S = 'M5.9 -5.3C5.1 -7.6 2.9 -8.7 0 -8.7C-3.5 -8.7 -5.8 -6.9 -5.8 -4.4C-5.8 -1.5 -3.1 -0.7 0 0C3.3 0.7 6.1 1.5 6.1 4.5C6.1 7.2 3.6 8.7 0 8.7C-3.2 8.7 -5.6 7.3 -6.3 4.9';
const USD_BAR = 'M0 -12.2V12.2';

/**
 * The gold coin printed on the note: a raised rim lit from the top left, a sunk field with its soft
 * shadow under the rim, a dotted ring, and the dollar sign struck in relief (its light edge up and
 * left, its shadow down and right). (cx, cy) the centre; the coin is 26 px in radius.
 */
function dollarCoin(p, cx, cy) {
  const sign = (attrs) => `<path d="${USD_S}" stroke-width="3" stroke-linecap="butt" ${attrs}/><path d="${USD_BAR}" stroke-width="2.3" stroke-linecap="round" ${attrs}/>`;
  return `<circle cx="${cx}" cy="${cy}" r="27" fill="#8A6410" opacity="0.28" ${f(p, 'b2')} transform="translate(1.5 2.5)"/>
<g transform="translate(${cx} ${cy})">
<circle r="26" fill="url(#${p}cn)"/>
<circle r="25.4" fill="none" stroke="url(#${p}cnr)" stroke-width="1.1"/>
<path d="M18.4 18.4A26 26 0 0 1 -6.7 25.1" fill="none" stroke="${TEAL}" stroke-opacity="0.45" stroke-width="1" ${f(p, 'b06')}/>
<circle r="20.6" fill="url(#${p}cnf)"/>
<clipPath id="${p}cnclip"><circle r="20.6"/></clipPath>
<g clip-path="url(#${p}cnclip)"><circle r="21.6" cx="1" cy="1.4" fill="none" stroke="#5A3C08" stroke-opacity="0.5" stroke-width="3.2" ${f(p, 'b1')}/></g>
<circle r="20.6" fill="none" stroke="url(#${p}cnw)" stroke-width="1.3"/>
<circle r="17.8" fill="none" stroke="#7A5614" stroke-opacity="0.5" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="0.01 2.33"/>
<g fill="none" stroke-linejoin="round">
<g transform="translate(0.75 1.05)" stroke="#4A3207" stroke-opacity="0.55" ${f(p, 'b06')}>${sign('')}</g>
<g transform="translate(-0.3 -0.42)" stroke="#FFF9E6" stroke-opacity="0.8">${sign('')}</g>
<g stroke="url(#${p}usd)">${sign('')}</g>
<path d="M-4.9 -6.6C-3.8 -7.9 -2.1 -8.2 0 -8.2" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="0.7" stroke-linecap="round"/>
</g>
<ellipse cx="-9" cy="-11" rx="8" ry="3.6" fill="#FFFFFF" opacity="0.4" transform="rotate(-35 -9 -11)" ${f(p, 'b2')}/>
</g>`;
}

// ------------------------------------------------------------------ the card pictures (250 by 200)

/** Start free: a gift box, tied with a gold ribbon, on the teal card. */
const GIFT = (p) => `<defs>${filters(p)}
${rg(`${p}aura`, { cx: '50%', cy: '55%' }, [
  [0, '#FFFFFF', 0.28],
  [1, '#FFFFFF', 0],
])}
${lg(`${p}bf`, [0, 0, 0.9, 1], [
  [0, '#FFFFFF'],
  [0.45, '#E9F8F3'],
  [1, '#B5E0D4'],
])}
${lg(`${p}bs`, [0, 0, 1, 1], [
  [0, '#C6EAE0'],
  [0.6, '#88C5B5'],
  [1, '#5DA694'],
])}
${lg(`${p}lf`, [0, 0, 0.8, 1], [
  [0, '#FFFFFF'],
  [0.5, '#F0FAF7'],
  [1, '#C8EAE1'],
])}
${lg(`${p}lt`, [0, 0, 1, 1], [
  [0, '#FFFFFF'],
  [1, '#DDF3EC'],
])}
${lg(`${p}ls`, [0, 0, 1, 1], [
  [0, '#D3EFE7'],
  [1, '#7FBDAC'],
])}
${lg(`${p}rv`, [0, 0, 1, 0], [
  [0, '#A97A24'],
  [0.22, '#F6D98E'],
  [0.45, '#E2B552'],
  [0.8, '#B3802A'],
  [1, '#8A6410'],
])}
${lg(`${p}rt`, [0, 0, 1, 1], [
  [0, '#FFF0BE'],
  [0.5, '#EBC36A'],
  [1, '#C49035'],
])}
${lg(`${p}rs`, [0, 0, 1, 0], [
  [0, '#B3802A'],
  [1, '#7A5512'],
])}
${lg(`${p}loop`, [0, 0, 1, 1], [
  [0, '#FFF0BE'],
  [0.35, '#F2CF78'],
  [0.7, '#D9A845'],
  [1, '#A97A24'],
])}
</defs>
<ellipse cx="128" cy="112" rx="96" ry="72" fill="url(#${p}aura)"/>
${contact(p, 128, 176, 74, 6, 0.4, '#00302A')}
<path d="M160 104L188 92V158Q188 161 185 162.4L160 172Z" fill="url(#${p}bs)"/>
<path d="M66 104H160V172H70Q66 172 66 168Z" fill="url(#${p}bf)"/>
<path d="M66 108H160V116H66Z" fill="#00302A" opacity="0.16" ${f(p, 'b2')}/>
<path d="M160 108L188 96V103L160 116Z" fill="#00302A" opacity="0.2" ${f(p, 'b2')}/>
<path d="M104 108H124V172H104Z" fill="url(#${p}rv)"/>
<path d="M170 99.7L178 96.3V165.6L170 168.4Z" fill="url(#${p}rs)"/>
<path d="M110.5 112V170" stroke="#FFF4CF" stroke-opacity="0.75" stroke-width="1.3" stroke-linecap="round"/>
<path d="M67.5 112V168" stroke="#FFFFFF" stroke-opacity="0.9" stroke-width="1.2" stroke-linecap="round" ${f(p, 'b06')}/>
<path d="M188 93V158" stroke="${TEAL}" stroke-opacity="0.45" stroke-width="4" ${f(p, 'b2')}/>
<path d="M188 93V158Q188 161 185 162.4L160 172" fill="none" stroke="#9FF5E2" stroke-opacity="0.9" stroke-width="1.2"/>
<g opacity="0.04" ${f(p, 'grain')}><path d="M66 104H160V172H70Q66 172 66 168Z" fill="#FFFFFF"/></g>
<path d="M60 88H166V108H62Q60 108 60 106Z" fill="url(#${p}lf)"/>
<path d="M166 88L196 76V93.6Q196 95 194.6 95.6L166 108Z" fill="url(#${p}ls)"/>
<path d="M60 88L90 76H196L166 88Z" fill="url(#${p}lt)"/>
<path d="M102 88H126V108H102Z" fill="url(#${p}rv)"/>
<path d="M102 88L132 76H156L126 88Z" fill="url(#${p}rt)"/>
<path d="M72 83.2H178L184 80.8H78Z" fill="url(#${p}rt)"/>
<path d="M176 84L184 80.8V100.4L176 103.7Z" fill="url(#${p}rs)"/>
<path d="M61 88.6H165" stroke="#FFFFFF" stroke-width="1.3" stroke-linecap="round"/>
<path d="M90.5 76.6H195" stroke="#FFFFFF" stroke-opacity="0.8" stroke-width="1"/>
<ellipse cx="96" cy="82" rx="24" ry="3.2" fill="#FFFFFF" opacity="0.85" transform="rotate(-8 96 82)" ${f(p, 'b2')}/>
<path d="M196 77V94" stroke="#9FF5E2" stroke-opacity="0.9" stroke-width="1.2"/>
<path d="M124 85L112 107L120.5 104L124 112L130 86Z" fill="url(#${p}loop)"/>
<path d="M135 85L148 104L139.5 102.5L137 110L131 86Z" fill="url(#${p}rv)"/>
<path d="M129 82C112 55 84 58 95 76C101 85 116 85 129 82Z" fill="url(#${p}loop)"/>
<path d="M129 82C116 66 102 65 103 74C110 80 120 81.5 129 82Z" fill="#7A5512" opacity="0.45" ${f(p, 'b1')}/>
<path d="M129 82C146 53 176 57 164 75C158 84 142 85 129 82Z" fill="url(#${p}loop)"/>
<path d="M129 82C142 66 157 64 156 73C150 79 139 81.5 129 82Z" fill="#7A5512" opacity="0.45" ${f(p, 'b1')}/>
<path d="M97 68C102 62 110 61 116 64" fill="none" stroke="#FFF6D8" stroke-width="1.6" stroke-linecap="round" opacity="0.9"/>
<path d="M141 63C148 58 158 58 162 62" fill="none" stroke="#FFF6D8" stroke-width="1.6" stroke-linecap="round" opacity="0.9"/>
<path d="M164 75C160 81 150 84 138 83.5" fill="none" stroke="${TEAL}" stroke-opacity="0.7" stroke-width="1.2" ${f(p, 'b06')}/>
<ellipse cx="129" cy="82" rx="8.5" ry="6.5" fill="url(#${p}rt)"/>
<ellipse cx="126.5" cy="79.8" rx="3.6" ry="2" fill="#FFFFFF" opacity="0.8" ${f(p, 'b06')}/>
${sparkle(p, 210, 38, 9)}${sparkle(p, 40, 58, 6)}${sparkle(p, 214, 150, 5, '#D9FFF6')}${sparkle(p, 52, 150, 3.5, '#D9FFF6')}`;

/**
 * A drawn code: three finder squares and a scatter of modules on an 11 by 11 grid, from a fixed seed.
 * No QR code has 11 modules a side (the smallest has 21), so nothing can read it as one. (x, y) the top
 * left, s the side.
 */
function dummyCode(x, y, s, seed) {
  const c = s / 11;
  const sq = (cx, cy, w) => `M${r1(x + cx)} ${r1(y + cy)}h${r1(w)}v${r1(w)}h${r1(-w)}z`;
  let ink = '';
  let hole = '';
  let eye = '';
  for (const [i, j] of [
    [0, 0],
    [8, 0],
    [0, 8],
  ]) {
    // The finder's 7:5:3 squares, over three cells.
    ink += sq(i * c, j * c, 3 * c);
    hole += sq(i * c + (3 / 7) * c, j * c + (3 / 7) * c, (15 / 7) * c);
    eye += sq(i * c + (6 / 7) * c, j * c + (6 / 7) * c, (9 / 7) * c);
  }
  let r = seed;
  for (let j = 0; j < 11; j++)
    for (let i = 0; i < 11; i++) {
      if ((i < 4 && j < 4) || (i > 6 && j < 4) || (i < 4 && j > 6)) continue;
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      if ((r >> 16) % 5 < 2) ink += sq(i * c + 0.25, j * c + 0.25, c - 0.5);
    }
  return `<path d="${ink}" fill="#14161A"/><path d="${hole}" fill="#FFFFFF"/><path d="${eye}" fill="#14161A"/>`;
}

// The note, drawn flat at 220 by 64: the banknote panel, the torn line at T and the right-hand code (the
// left-hand code is out of the picture, so it is not drawn).
const NW = 220;
const NH = 64;
const T = 163;
// The right-hand code's centre on the note, and where the picture puts it: in the middle of the camera's
// frame (FX, FY), drawn NK times larger and tilted NA degrees, so the note runs off the left edge.
const CODE = [193, 28];
const [FX, FY, NK, NA] = [152, 100, 2.22, -7];

/**
 * Scan a note: a printed paper note (Forge's eCash on paper), as the notes are printed (a code at each
 * end, the value between them, a torn line before the right-hand code, the one that holds the money),
 * seen close: that code large in the camera's frame, the torn line beside it, and the banknote panel
 * fading out at the picture's left edge, x0 (further left on the wider hero).
 */
const NOTE = (p, x0 = 0) => {
  const guil = [];
  // The engraved rosette: one ellipse turned eight times, in two rings.
  for (let i = 0; i < 8; i++) guil.push(`<ellipse cx="132" cy="40" rx="14" ry="5" transform="rotate(${i * 22.5} 132 40)"/>`);
  guil.push('<circle cx="132" cy="40" r="15.5"/><circle cx="132" cy="40" r="4"/>');
  const wave = [];
  for (let i = 0; i < 3; i++) wave.push(`M62 ${50 + i * 3}q4 -2.6 8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0`);
  // The paper, with a half-round bite at each end of the torn line.
  const paper = `M3 0H${T - 2.4}a2.4 2.4 0 0 0 4.8 0H${NW - 3}a3 3 0 0 1 3 3V${NH - 3}a3 3 0 0 1-3 3H${T + 2.4}a2.4 2.4 0 0 0-4.8 0H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3Z`;
  // The camera's frame, upright, as the other pictures draw it: its sides (left, right, top, bottom) and
  // the corners' arms, 30 long.
  const [L, R, U, D] = [FX - 86, FX + 84, FY - 84, FY + 84];
  const k = 30;
  const frame = `M${L} ${U + k}V${U + 10}a10 10 0 0 1 10-10H${L + k}M${R - k} ${U}H${R - 10}a10 10 0 0 1 10 10V${U + k}M${R} ${D - k}V${D - 10}a10 10 0 0 1-10 10H${R - k}M${L + k} ${D}H${L + 10}a10 10 0 0 1-10-10V${D - k}`;
  // A stub: the code on white in its thin frame, a short line of print under it (red under the money's).
  const stub = (x, seed, line) => `<rect x="${x - 3}" y="2.5" width="52" height="59" rx="2.5" fill="none" stroke="#4E7A5E" stroke-opacity="0.7" stroke-width="0.9"/>
<rect x="${x}" y="5" width="46" height="46" rx="1.5" fill="#FFFFFF"/>
${dummyCode(x + 3, 8, 40, seed)}
<rect x="${x + 11}" y="54.6" width="24" height="2.2" rx="1.1" fill="${line}"/>`;
  return `<defs>${filters(p)}
${lg(`${p}pp`, [0, 0, 1, 1], [
  [0, '#FFFEF8'],
  [0.5, '#F8F1DC'],
  [1, '#E9DCB6'],
])}
${lg(`${p}panel`, [0, 0, 1, 1], [
  [0, '#F3F2DE'],
  [1, '#DCE3C6'],
])}
${dollarDefs(p)}
${lg(`${p}sheen`, [0, 0, 1, 1], [
  [0, '#FFFFFF', 0],
  [0.45, '#FFFFFF', 0.55],
  [0.6, '#FFFFFF', 0],
])}
${lg(`${p}fade`, [x0, 0, x0 + 64, 0], [
  [0, '#000000'],
  [1, '#FFFFFF'],
], true)}
<mask id="${p}edge" maskUnits="userSpaceOnUse" x="${x0 - 20}" y="-20" width="${290 - x0}" height="240"><rect x="${x0 - 20}" y="-20" width="${290 - x0}" height="240" fill="url(#${p}fade)"/></mask>
<clipPath id="${p}paper"><path d="${paper}"/></clipPath>
</defs>
<g mask="url(#${p}edge)">
<g transform="translate(${FX} ${FY}) rotate(${NA}) scale(${NK}) translate(${-CODE[0]} ${-CODE[1]})">
<path d="${paper}" fill="#5A3C08" opacity="0.3" transform="translate(1.5 3.5)" ${f(p, 'b2')}/>
<path d="${paper}" fill="url(#${p}pp)" stroke="#BFAE80" stroke-opacity="0.8" stroke-width="0.4"/>
<g clip-path="url(#${p}paper)">
<rect x="59" y="3" width="100" height="58" rx="2" fill="url(#${p}panel)"/>
<g fill="none" stroke="#4E7A5E" stroke-opacity="0.4" stroke-width="0.5">${guil.join('')}</g>
<path d="${wave.join('')}" fill="none" stroke="#4E7A5E" stroke-opacity="0.35" stroke-width="0.5"/>
<path d="M150 0H200L170 ${NH}H120Z" fill="url(#${p}sheen)" opacity="0.5"/>
</g>
<rect x="59" y="3" width="100" height="58" rx="2" fill="none" stroke="#4E7A5E" stroke-width="1.1"/>
<rect x="61.5" y="5.5" width="95" height="53" rx="1.2" fill="none" stroke="#4E7A5E" stroke-opacity="0.55" stroke-width="0.5" stroke-dasharray="1 1.4"/>
<path d="M68 11.5H80M68 11.5L67 21Q71 19 74.5 19.6Q80.5 21 80.5 27Q80.5 33.5 74 33.5Q69.5 33.5 67.5 30.5" fill="none" stroke="#2F5A40" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="85" y="13" width="28" height="2.6" rx="1.3" fill="#2F5A40" opacity="0.7"/>
<rect x="66" y="39" width="44" height="17" rx="1.6" fill="#FFFFFF" fill-opacity="0.45" stroke="#4E7A5E" stroke-opacity="0.6" stroke-width="0.6"/>
<rect x="69" y="44.6" width="20" height="2.2" rx="1.1" fill="#B23A2A" opacity="0.75"/>
<g transform="translate(145 18) scale(0.5)">${dollarCoin(p, 0, 0)}</g>
<path d="M${T} 4V60" stroke="#6B6A60" stroke-opacity="0.75" stroke-width="0.7" stroke-dasharray="2 1.6"/>
${stub(170, 29, '#C0392B')}
<path d="M${NW - 0.4} 4V${NH - 3}a2.6 2.6 0 0 1-2.6 2.6H${T + 4}" fill="none" stroke="${TEAL}" stroke-opacity="0.6" stroke-width="0.7" ${f(p, 'b06')}/>
<path d="M${T + 4} 0.4H${NW - 3}a2.6 2.6 0 0 1 2.6 2.6" fill="none" stroke="#FFFFFF" stroke-width="0.6"/>
<path d="M0.4 ${NH - 4}V3a2.6 2.6 0 0 1 2.6-2.6H${T - 4}" fill="none" stroke="#FFFFFF" stroke-width="0.6"/>
</g>
</g>
<g fill="none" stroke-linecap="round">
<path d="${frame}" stroke="#E2B552" stroke-opacity="0.45" stroke-width="10" ${f(p, 'b2')}/>
<path d="${frame}" stroke="#8A6410" stroke-width="5"/>
<path d="M${L - 0.8} ${U + k - 2}V${U + 9.2}a10 10 0 0 1 10-10H${L + k - 2}" stroke="#F6D98E" stroke-width="1.4"/>
</g>`;
};

/** Lightning: the bolt as a lit gold object, thick, glowing, over the dark card. */
const BOLT = (p) => {
  const d = 'M135 26 80 108h38l-10 64 60-86h-40z';
  const depth = [];
  for (let i = 7; i >= 1; i--) depth.push(`<path d="${d}" transform="translate(${i} ${i * 0.9})" fill="${i > 5 ? '#4A3307' : i > 2 ? '#7A5512' : '#9C7020'}"/>`);
  return `<defs>${filters(p)}
${rg(`${p}gl`, {}, [
  [0, '#E2B552', 0.55],
  [0.6, '#E2B552', 0.12],
  [1, '#E2B552', 0],
])}
${rg(`${p}tl`, { cx: '80%', cy: '85%', r: '60%' }, [
  [0, TEAL, 0.1],
  [1, TEAL, 0],
])}
${lg(`${p}bt`, [0.1, 0, 0.9, 1], [
  [0, '#FFF6D8'],
  [0.25, '#F7DC95'],
  [0.6, '#E2B552'],
  [1, '#B3802A'],
])}
${rg(`${p}in`, { cx: '35%', cy: '30%', r: '55%' }, [
  [0, '#FFFFFF', 0.6],
  [1, '#FFFFFF', 0],
])}
${lg(`${p}ring`, [0, 0, 1, 1], [
  [0, '#F7DC95', 0.6],
  [0.5, '#E2B552', 0.15],
  [1, TEAL, 0.5],
])}
</defs>
<circle cx="125" cy="100" r="98" fill="url(#${p}gl)"/>
<circle cx="125" cy="100" r="98" fill="url(#${p}tl)"/>
<ellipse cx="125" cy="100" rx="78" ry="78" fill="none" stroke="url(#${p}ring)" stroke-width="1.4"/>
<ellipse cx="125" cy="100" rx="60" ry="60" fill="none" stroke="#D4A544" stroke-opacity="0.22" stroke-width="1"/>
<ellipse cx="128" cy="184" rx="54" ry="6" fill="#E2B552" opacity="0.3" ${f(p, 'b4')}/>
<ellipse cx="132" cy="184" rx="26" ry="3" fill="#000000" opacity="0.6" ${f(p, 'b2')}/>
<path d="${d}" fill="#E2B552" opacity="0.55" ${f(p, 'b8')}/>
${depth.join('')}
<path d="M168 86L108 172" transform="translate(6 5.4)" stroke="${TEAL}" stroke-opacity="0.35" stroke-width="1.4" ${f(p, 'b1')}/>
<path d="${d}" fill="url(#${p}bt)"/>
<path d="${d}" fill="url(#${p}in)"/>
<path d="M135 26 80 108h38" fill="none" stroke="#FFFBEA" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
<path d="M128 86h40" fill="none" stroke="#FFF4CF" stroke-opacity="0.8" stroke-width="1.4" stroke-linecap="round"/>
<path d="M126 36 92 100" stroke="#FFFFFF" stroke-opacity="0.9" stroke-width="3" stroke-linecap="round" ${f(p, 'b1')}/>
<path d="M168 86L108 172" stroke="${TEAL}" stroke-opacity="0.5" stroke-width="1.2"/>
${sparkle(p, 196, 44, 8)}${sparkle(p, 58, 64, 5)}${sparkle(p, 186, 150, 4, '#BFF7EA')}<circle cx="70" cy="146" r="1.8" fill="#FFF4CF" opacity="0.8"/><circle cx="204" cy="96" r="1.4" fill="#FFF4CF" opacity="0.7"/>`;
};

/**
 * A card held to the back of a phone, the tap's waves between them. face: the card's printed face
 * (screens/brands/cards.js), drawn as the card itself, with its shadow and the scene's light on its edges.
 */
const tapScene = (face) => (p) => `<defs>${filters(p)}
${lg(`${p}ph`, [0, 0, 1, 1], [
  [0, '#4A525E'],
  [0.35, '#262B33'],
  [1, '#0B0D10'],
])}
${rg(`${p}sc`, { cx: '40%', cy: '35%', r: '75%' }, [
  [0, '#24323A'],
  [1, '#0B0F12'],
])}
${rg(`${p}tgt`, {}, [
  [0, TEAL, 0.55],
  [1, TEAL, 0],
])}
${lg(`${p}glare`, [0, 0, 1, 1], [
  [0, '#FFFFFF', 0.16],
  [0.5, '#FFFFFF', 0.02],
  [1, '#FFFFFF', 0],
])}
</defs>
${contact(p, 176, 184, 46, 4, 0.35, '#0B0D10')}
<rect x="134" y="24" width="86" height="160" rx="18" fill="#000000" opacity="0.3" ${f(p, 'b4')}/>
<rect x="130" y="18" width="86" height="160" rx="18" fill="url(#${p}ph)"/>
<rect x="137" y="28" width="72" height="140" rx="11" fill="url(#${p}sc)"/>
<circle cx="173" cy="96" r="30" fill="url(#${p}tgt)"/>
<circle cx="173" cy="96" r="13" fill="none" stroke="${TEAL}" stroke-opacity="0.7" stroke-width="1.6"/>
<path d="M137 40V39A11 11 0 0 1 148 28H200L150 168H148A11 11 0 0 1 137 157Z" fill="url(#${p}glare)"/>
<path d="M131.5 40V156" stroke="#FFFFFF" stroke-opacity="0.4" stroke-width="1.2" stroke-linecap="round"/>
<path d="M215 40V158A18 18 0 0 1 199 177" fill="none" stroke="${TEAL}" stroke-opacity="0.75" stroke-width="1.4" ${f(p, 'b06')}/>
<rect x="216" y="56" width="2.6" height="20" rx="1.3" fill="#2A2F37"/>
<g transform="rotate(-16 92 112)">
<rect x="25" y="78" width="140" height="88" rx="6" fill="#000000" opacity="0.3" ${f(p, 'b4')}/>
${face(p, { x: 22, y: 70 })}
<path d="M23.5 150V77A5.5 5.5 0 0 1 29 71.5H150" fill="none" stroke="#FFFFFF" stroke-opacity="0.7" stroke-width="1.1"/>
<path d="M160.5 78V152A5.5 5.5 0 0 1 155 157.5H50" fill="none" stroke="${TEAL}" stroke-opacity="0.7" stroke-width="1.3" ${f(p, 'b06')}/>
</g>
<g fill="none" stroke-linecap="round">
<path d="M150 72a22 22 0 0 1 0 36M160 62a36 36 0 0 1 0 56M170 52a50 50 0 0 1 0 76" stroke="${TEAL}" stroke-opacity="0.55" stroke-width="7" ${f(p, 'b2')} transform="translate(-14 4)"/>
<path d="M150 72a22 22 0 0 1 0 36M160 62a36 36 0 0 1 0 56M170 52a50 50 0 0 1 0 76" stroke="#FFF6DD" stroke-width="4" transform="translate(-14 4)"/>
</g>
${sparkle(p, 44, 40, 6, '#FFF6DD')}`;

/** eCash: the C-Pay coin stack, with one coin tipped on top. */
const COINS = (p) => `<defs>${filters(p)}${coinDefs(p)}
${rg(`${p}aura`, { cy: '60%' }, [
  [0, '#E2B552', 0.3],
  [1, '#E2B552', 0],
])}
</defs>
<ellipse cx="126" cy="128" rx="100" ry="70" fill="url(#${p}aura)"/>
${contact(p, 127, 181, 62, 6, 0.45, '#5A3C08')}
${coin(p, { cx: 128, cy: 154, rx: 54, ry: 16, h: 15 })}
<ellipse cx="124" cy="154" rx="55" ry="16.5" fill="#000000" opacity="0.35" ${f(p, 'b2')}/>
${coin(p, { cx: 122, cy: 138, rx: 54, ry: 16, h: 15 })}
<ellipse cx="128" cy="138" rx="55" ry="16.5" fill="#000000" opacity="0.35" ${f(p, 'b2')}/>
${coin(p, { cx: 129, cy: 122, rx: 54, ry: 16, h: 15 })}
<g transform="rotate(-10 134 92)">
<ellipse cx="136" cy="116" rx="52" ry="14" fill="#000000" opacity="0.28" ${f(p, 'b4')}/>
${coin(p, { cx: 134, cy: 86, rx: 54, ry: 21, h: 13 })}
</g>
<ellipse cx="78" cy="138" rx="3" ry="9" fill="#FFF6DC" opacity="0.45" ${f(p, 'b1')}/>
<ellipse cx="72" cy="154" rx="3" ry="8" fill="#FFF6DC" opacity="0.35" ${f(p, 'b1')}/>
${sparkle(p, 202, 40, 7, '#E2B552')}${sparkle(p, 48, 66, 5, '#E2B552')}`;

/** Tap a Cashu card and Tap a Fedimint card: each card, as printed, at the phone. */
const CARD = tapScene(cashuFace);
const FEDIMINT = tapScene(fedimintFace);

/** The two cards together (Funds' fanned stack): the Fedimint card behind, the Cashu card in front. */
const CARDS = (p) => `<defs>${filters(p)}</defs>
${contact(p, 125, 176, 80, 5, 0.3, '#0B0D10')}
<g transform="rotate(10 160 90)"><rect x="83" y="52" width="140" height="88" rx="6" fill="#000000" opacity="0.28" ${f(p, 'b4')}/>${fedimintFace(`${p}f`, { x: 80, y: 44 })}</g>
<g transform="rotate(-12 90 120)"><rect x="23" y="88" width="140" height="88" rx="6" fill="#000000" opacity="0.3" ${f(p, 'b4')}/>${cashuFace(`${p}c`, { x: 20, y: 80 })}</g>`;

const ART = { start: GIFT, note: NOTE, lightning: BOLT, card: CARD, fedimint: FEDIMINT, cards: CARDS, ecash: COINS };

// ------------------------------------------------------------------ the More ways (100 by 100)

/** A lit disc in a way's colour, with its contact shadow: the stage of each More way. */
const disc = (p, [a, b, c]) => `${rg(`${p}disc`, { fx: '34%', fy: '28%' }, [
  [0, a],
  [0.6, b],
  [1, c],
])}${lg(`${p}drim`, [0, 0, 1, 1], [
  [0, '#FFFFFF', 0.9],
  [0.5, '#FFFFFF', 0.1],
  [1, TEAL, 0.7],
])}`;
const discBody = (p) => `<ellipse cx="50" cy="93" rx="34" ry="3.4" fill="#000000" opacity="0.18" ${f(p, 'b2')}/><circle cx="50" cy="50" r="44" fill="url(#${p}disc)"/><circle cx="50" cy="50" r="43.4" fill="none" stroke="url(#${p}drim)" stroke-width="1.2"/>`;

const SPOT = {
  // On-chain: a bitcoin coin.
  onchain: (p) => `<defs>${filters(p)}${coinDefs(p)}${disc(p, ['#FFFBEF', '#F6E9C8', '#E2C789'])}</defs>${discBody(p)}
<ellipse cx="50" cy="72" rx="26" ry="5" fill="#5A3C08" opacity="0.3" ${f(p, 'b2')}/>
${coin(p, { cx: 50, cy: 46, rx: 27, ry: 19, h: 8, mark: 'btc' })}`,
  // Free questions: a voucher, torn off, with its star.
  free: (p) => `<defs>${filters(p)}${disc(p, ['#FAFFF0', '#E9F5C9', '#BFD98A'])}
${lg(`${p}tk`, [0, 0, 1, 1], [
  [0, '#FFFFFF'],
  [0.6, '#F3FAE6'],
  [1, '#CFE6A6'],
])}
${lg(`${p}st`, [0, 0, 1, 1], [
  [0, '#FFE7A3'],
  [0.5, '#E2B552'],
  [1, '#B3802A'],
])}</defs>${discBody(p)}
<g transform="rotate(-12 50 50)">
<path d="M18 34h64v10a6 6 0 0 0 0 12v10H18V56a6 6 0 0 0 0-12z" fill="#3B5A0E" opacity="0.3" transform="translate(2 4)" ${f(p, 'b2')}/>
<path d="M18 34h64v10a6 6 0 0 0 0 12v10H18V56a6 6 0 0 0 0-12z" fill="url(#${p}tk)"/>
<path d="M64 36v28" stroke="#4C7A12" stroke-opacity="0.6" stroke-width="1.4" stroke-dasharray="2.4 2.6" stroke-linecap="round"/>
<path d="M40 38.5l3.6 7.3 8 1.2-5.8 5.6 1.4 8L40 56.8l-7.2 3.8 1.4-8-5.8-5.6 8-1.2z" fill="#7A5512" opacity="0.4" transform="translate(0.8 1.2)"/>
<path d="M40 38.5l3.6 7.3 8 1.2-5.8 5.6 1.4 8L40 56.8l-7.2 3.8 1.4-8-5.8-5.6 8-1.2z" fill="url(#${p}st)"/>
<path d="M37 44l3-5.5" stroke="#FFFBEA" stroke-width="1" stroke-linecap="round"/>
<rect x="68" y="44" width="9" height="2.4" rx="1.2" fill="#4C7A12" opacity="0.5"/><rect x="68" y="50" width="6" height="2.4" rx="1.2" fill="#4C7A12" opacity="0.4"/>
<path d="M18.6 66V56a6 6 0 0 0 0-12V34.6H82" fill="none" stroke="#FFFFFF" stroke-width="0.9"/>
<path d="M82 56v10H22" fill="none" stroke="${TEAL}" stroke-opacity="0.7" stroke-width="1" ${f(p, 'b06')}/>
</g>`,
};

/**
 * The big picture of a card. id: the way; mod: its fund module (for its icon, when this file has no
 * picture for it). label: what the picture shows, for screen readers.
 */
export function cardArt(id, mod, label) {
  const p = prefix();
  if (ART[id]) return svg(ART[id](p), { w: 250, h: 200, box: '0 0 250 200', label, cls: 'way-art-svg' });
  if (SPOT[id]) return svg(SPOT[id](p), { w: 200, h: 200, box: '0 0 100 100', label, cls: 'way-art-svg' });
  // A way added later: its own icon on a lit disc.
  return el('span', { class: 'way-art-disc', role: 'img', 'aria-label': label }, icon(mod?.icon ?? 'plus', 72, 1.6));
}

/**
 * A way's card as the hero at the top of its own screen (and Take funds out's): the picture on the
 * card's own ground, as on Add money, so a person knows where they are without reading. Only a picture.
 */
export function wayHero(id, mod) {
  // The hero is wider than a card: the note's picture opens 60 further left, so the note runs on and
  // fades near the hero's own left edge instead of in its middle.
  const art = id === 'note' ? svg(NOTE(prefix(), -60), { w: 370, h: 200, box: '-60 0 370 200', cls: 'way-art-svg' }) : cardArt(id, mod, null);
  return el('div', { class: 'way-hero', 'data-way': id, 'aria-hidden': 'true' }, art);
}

/** The small picture on a More tile. */
export function spotArt(id, mod) {
  if (SPOT[id]) return svg(SPOT[id](prefix()), { w: 64, h: 64, box: '0 0 100 100', cls: 'way-spot' });
  return el('span', { class: 'way-spot way-spot-disc', 'aria-hidden': 'true' }, icon(mod?.icon ?? 'plus', 28));
}

// ------------------------------------------------------------------ the tabs

// The tab icons (24 px grid): simple at this size, in the same family as the pictures (the line icons
// of the app, with a soft fill where the picture has a body). Colours come from the look.
const TAB = {
  start: '<rect x="4" y="10" width="16" height="10" rx="1.5" fill="currentColor" fill-opacity="0.16"/><rect x="3" y="7" width="18" height="4" rx="1"/><path d="M4 11v8.5a.5.5 0 0 0 .5.5h15a.5.5 0 0 0 .5-.5V11M12 7v13M12 7c-1.6-3.2-5.4-3.4-5.4-1.2S10 7 12 7c2 0 5.4 1 5.4-1.2S13.6 3.8 12 7z"/>',
  note: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="7" y="8.5" width="10" height="7" rx="1" fill="currentColor" fill-opacity="0.16"/><circle cx="10" cy="12" r="1.6"/>',
  lightning: '<path d="M13.2 2.5 5 13.6h6.1l-1.2 7.9 8.2-11.1H12z" fill="currentColor" fill-opacity="0.22"/>',
  // The two cards: a card and its waves, with the brand's plain shape where the chip would be (the
  // cashew of the Cashu card, the heptagon of the Fedimint card), so the two tabs are told apart.
  card: '<rect x="2" y="6" width="15" height="11" rx="2.5" fill="currentColor" fill-opacity="0.16"/><path transform="translate(4.9 6.8) scale(.092) rotate(-14 50 50)" d="M58 7C76 7 90 18 90 33C90 46 78 50 66 52C58 53 55 60 59 68C62 74 70 77 70 85C70 92 63 96 54 96C30 96 10 77 10 52C10 27 31 7 58 7Z" fill="currentColor" stroke="none"/><path d="M19 8a4 4 0 0 1 0 6M21.5 6a7 7 0 0 1 0 10"/>',
  ecash: '<ellipse cx="12" cy="6" rx="7" ry="3" fill="currentColor" fill-opacity="0.22"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  more: '<circle cx="6" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="18" cy="12" r="2" fill="currentColor"/>',
  onchain: '<circle cx="12" cy="12" r="9" fill="currentColor" fill-opacity="0.16"/><path d="M9.5 7.5H13a2.2 2.2 0 0 1 0 4.4H9.5h4a2.3 2.3 0 0 1 0 4.6h-4zM9.5 7.5v9M11 6v1.5M13 6v1.5M11 16.5V18M13 16.5V18"/>',
  free: '<path d="M3 8h18v3a1.6 1.6 0 0 0 0 3.2V17H3v-2.8A1.6 1.6 0 0 0 3 11z" fill="currentColor" fill-opacity="0.16"/><path d="M15 8v9" stroke-dasharray="1.6 1.8"/><path d="M9 9.8l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z"/>',
  // The two cards together: one behind the other, the waves of the tap.
  cards: '<rect x="6" y="3.5" width="13" height="9" rx="2" fill="currentColor" fill-opacity="0.16"/><rect x="2" y="9" width="14" height="10" rx="2.2" fill="currentColor" fill-opacity="0.16"/><path d="M5 13h3"/><path d="M19.5 14a3.5 3.5 0 0 1 0 5M22 12a6.5 6.5 0 0 1 0 9" transform="translate(-1 -1)"/>',
  fedimint: '<rect x="2" y="6" width="15" height="11" rx="2.5" fill="currentColor" fill-opacity="0.16"/><polygon transform="translate(-.5 3.7) scale(.2)" points="50,23 61.73,28.65 64.62,41.34 56.51,51.51 43.49,51.51 35.38,41.34 38.27,28.65" fill="currentColor" stroke="none"/><path d="M19 8a4 4 0 0 1 0 6M21.5 6a7 7 0 0 1 0 10"/>',
};

/** A tab's icon: the design's, or the module's own. */
export function tabIcon(id, mod) {
  if (!TAB[id]) return icon(mod?.icon ?? 'plus', 24);
  const s = svg(TAB[id], { w: 24, h: 24, box: '0 0 24 24', cls: 'ico' });
  for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
  return s;
}

// ------------------------------------------------------------------ Funds: the stack and the ring

/** One small card of the fanned stack on Funds (AddFunds-C4): the way's card, its picture on it. */
export function stackCard(id, mod, pos) {
  return el('span', { class: `stack-card stack-${pos}`, 'data-way': id, 'aria-hidden': 'true' }, el('span', { class: 'stack-shine' }), cardArt(id, mod, null));
}

/**
 * The funds ring on Funds, drawn as the first run draws its rings: a gold arc with its glow over a soft
 * track, its lit tip, and the centre disc, which turns teal on a free model at $0 (AddFunds-C4).
 * Returns {node, set(fraction, free, freeZero)}; the node keeps data-funds and data-free in path units.
 */
export function fundsRing() {
  const p = prefix();
  const R = 72;
  const W = 16;
  const node = svg(
    `<defs>${filters(p)}
${rg(`${p}aura`, {}, [
  [0.55, '#E2B552', 0.22],
  [0.8, '#E2B552', 0.06],
  [1, '#E2B552', 0],
])}
${lg(`${p}gold`, [0, 0, 1, 1], [
  [0, '#F7DC95'],
  [0.5, '#E2B552'],
  [1, '#C08A2A'],
])}
${rg(`${p}cl`, { fx: '34%', fy: '28%' }, [
  [0, '#FFFFFF'],
  [0.7, '#F6F5F1'],
  [1, '#E6E2D6'],
])}
${rg(`${p}ct`, { fx: '34%', fy: '28%' }, [
  [0, '#F2FCF9'],
  [0.65, '#E3F4F0'],
  [1, '#B7E4DA'],
])}
${lg(`${p}crim`, [0, 0, 1, 1], [
  [0, '#FFFFFF', 0.95],
  [0.5, '#FFFFFF', 0.1],
  [1, TEAL, 0.7],
])}
</defs>
<circle cx="90" cy="90" r="90" fill="url(#${p}aura)"/>
<circle cx="90" cy="90" r="${R}" fill="none" stroke="var(--gold-track)" stroke-width="${W}"/>
<circle cx="90" cy="90" r="${R + W / 2 - 0.5}" fill="none" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="1"/>
<g transform="rotate(-90 90 90)" fill="none" stroke-linecap="round">
<circle class="ring-fill fr-free" cx="90" cy="90" r="${R}" stroke="var(--gold-free)" stroke-width="${W}"/>
<circle class="ring-fill fr-glow" cx="90" cy="90" r="${R}" stroke="#E2B552" stroke-width="${W + 6}" opacity="0.35" ${f(p, 'b4')}/>
<circle class="ring-fill fr-paid" cx="90" cy="90" r="${R}" stroke="url(#${p}gold)" stroke-width="${W}"/>
</g>
<circle class="fr-tipglow" cx="90" cy="18" r="8" fill="#E2B552" opacity="0" ${f(p, 'b2')}/>
<circle class="fr-tipdot" cx="90" cy="18" r="3" fill="#FFF6DC" opacity="0"/>
<ellipse cx="92" cy="${90 + R - W / 2 - 6}" rx="40" ry="5" fill="#000000" opacity="0.08" ${f(p, 'b4')}/>
<circle class="fr-centre" cx="90" cy="90" r="${R - W / 2 - 6}" fill="url(#${p}cl)"/>
<circle cx="90" cy="90" r="${R - W / 2 - 6.5}" fill="none" stroke="url(#${p}crim)" stroke-width="1.2"/>
<ellipse cx="74" cy="66" rx="20" ry="8" fill="#FFFFFF" opacity="0.5" transform="rotate(-24 74 66)" ${f(p, 'b4')}/>`,
    { w: 180, h: 180, box: '0 0 180 180', cls: 'funds-ring-svg' },
  );
  const q = (sel) => node.querySelector(sel);
  return {
    node,
    set(fraction, free = 0, freeZero = false) {
      const fd = dash(free, R);
      const d = dashAfter(fraction, free, R);
      q('.fr-free').setAttribute('stroke-dasharray', fd.dasharray);
      q('.fr-free').style.opacity = fd.length < 0.5 ? '0' : '1';
      for (const s of ['.fr-paid', '.fr-glow']) {
        q(s).setAttribute('stroke-dasharray', d.dasharray);
        q(s).setAttribute('stroke-dashoffset', d.dashoffset);
        q(s).style.opacity = d.length < 0.5 ? '0' : '';
      }
      // The lit tip where the gold ends, as on the first run's rings.
      const end = (fd.length + d.length) / R - Math.PI / 2;
      const on = d.length >= 0.5;
      for (const s of ['.fr-tipglow', '.fr-tipdot']) {
        q(s).setAttribute('cx', String(r1(90 + R * Math.cos(end))));
        q(s).setAttribute('cy', String(r1(90 + R * Math.sin(end))));
      }
      q('.fr-tipglow').setAttribute('opacity', on ? '0.6' : '0');
      q('.fr-tipdot').setAttribute('opacity', on ? '1' : '0');
      q('.fr-centre').setAttribute('fill', `url(#${p}${freeZero ? 'ct' : 'cl'})`);
      node.dataset.funds = String(Math.round(d.length));
      node.dataset.free = String(Math.round(fd.length));
    },
  };
}

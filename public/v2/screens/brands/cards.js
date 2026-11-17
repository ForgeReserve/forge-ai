// The Cashu card and the Fedimint card as their makers print them, drawn as vectors for Add money and the
// card screens. The marks and the words ("cashucard", "fedimintcard") are the brands' own outlines, copied
// from their brand kits and rounded to whole units (SOURCES.md beside this file has where each comes from
// and its licence). The faces are laid out from the printed card art (cashu-card-front.png, card_front.png)
// in the brands' colours: the Cashu card pale lime to green, its cashew mark large on the right; the
// Fedimint card blue to night, its gold mark top left. Nothing is fetched: the markup is static and from
// this file only.
const NS = 'http://www.w3.org/2000/svg';

/** The cashew of the Cashu card mark, in its 100 by 100 box (brand/mark/cashu-card-mark.svg). */
const CASHEW = 'M58 7C76 7 90 18 90 33C90 46 78 50 66 52C58 53 55 60 59 68C62 74 70 77 70 85C70 92 63 96 54 96C30 96 10 77 10 52C10 27 31 7 58 7Z';
/** The words of the Cashu card lockup (brand/lockup/cashu-card-lockup-on-light.svg): x 160 to 567, y 28 to 99. */
const CASHU_WORD = 'M187 99Q179 99 173 95Q167 92 163 86Q160 80 160 73Q160 65 163 59Q167 53 173 50Q179 46 187 46Q195 46 201 50Q207 54 210 61L195 67Q194 64 192 63Q189 61 186 61Q183 61 181 62Q178 64 177 67Q176 69 176 73Q176 76 177 78Q178 81 181 83Q183 84 186 84Q189 84 192 82Q194 81 195 78L210 83Q207 91 201 95Q195 99 187 99ZM226 99Q218 99 213 95Q208 91 208 83Q208 76 213 72Q218 68 227 68L239 68Q239 64 237 62Q235 59 231 59Q228 59 226 61Q224 62 223 64L209 60Q211 56 214 53Q217 50 221 48Q225 46 231 46Q239 46 244 49Q249 52 252 57Q255 63 255 70L255 98L240 98L240 92Q238 96 234 97Q231 99 226 99ZM230 87Q233 87 235 86Q237 85 238 82Q240 80 240 78L240 78L233 78Q228 78 226 79Q224 81 224 83Q224 85 225 86Q227 87 230 87ZM277 99Q272 99 267 97Q263 96 260 93Q257 91 255 87L268 81Q270 84 272 85Q274 86 277 86Q279 86 280 86Q282 85 282 83Q282 82 280 81Q279 80 276 79L272 78Q265 76 261 72Q257 68 257 62Q257 55 263 51Q268 46 277 46Q283 46 287 48Q291 49 294 52Q296 54 298 58L285 63Q285 61 282 60Q280 59 278 59Q275 59 274 60Q273 61 273 62Q273 63 274 64Q276 65 279 66L284 67Q289 68 292 71Q295 73 297 76Q298 80 298 83Q298 88 296 92Q293 95 288 97Q283 99 277 99ZM299 98L299 28L315 28L315 54Q317 50 321 48Q325 46 329 46Q335 46 339 49Q343 51 345 56Q347 61 347 69L347 98L332 98L332 72Q332 68 331 66Q330 63 328 62Q326 61 324 61Q320 61 317 63Q315 66 315 71L315 98ZM368 99Q362 99 358 96Q354 94 352 89Q349 84 349 76L349 48L365 48L365 73Q365 77 366 79Q367 82 369 83Q370 84 373 84Q377 84 379 82Q382 79 382 74L382 48L397 48L397 98L383 98L382 91Q380 95 376 97Q372 99 368 99Z';
const CASHU_CARD = 'M425 99Q418 99 412 95Q406 92 403 86Q400 80 400 73Q400 65 403 59Q406 53 412 50Q418 46 425 46Q432 46 438 50Q444 53 447 59L439 62Q437 58 433 56Q430 54 425 54Q420 54 416 56Q412 59 410 63Q408 67 408 73Q408 78 410 82Q412 86 416 89Q420 91 425 91Q430 91 434 89Q438 86 440 82L447 85Q444 91 438 95Q432 99 425 99ZM466 99Q457 99 453 95Q448 91 448 83Q448 76 453 72Q458 68 467 68L481 68Q480 61 477 57Q474 53 468 53Q464 53 461 55Q458 57 456 60L449 58Q451 54 454 52Q456 49 460 48Q464 46 468 46Q475 46 480 49Q484 52 487 57Q489 63 489 70L489 98L481 98L481 91Q479 95 475 97Q471 99 466 99ZM467 92Q471 92 474 90Q477 88 479 85Q481 81 481 76L481 74L469 74Q462 74 459 77Q456 79 456 83Q456 87 459 89Q461 92 467 92ZM495 98L495 48L503 48L503 56Q506 52 511 50Q515 47 521 47L521 55Q516 55 512 56Q508 58 506 61Q503 64 503 70L503 98ZM542 99Q535 99 530 95Q525 92 522 86Q519 80 519 73Q519 65 522 59Q525 53 530 50Q535 46 542 46Q547 46 552 49Q556 51 559 56L559 28L567 28L567 98L559 98L559 89Q556 94 552 96Q547 99 542 99ZM544 91Q548 91 551 89Q555 87 557 82Q559 78 559 73L559 72Q559 67 557 63Q555 58 551 56Q548 54 544 54Q539 54 535 56Q532 58 530 63Q527 67 527 73Q527 78 530 82Q532 87 535 89Q539 91 544 91Z';
/** The words of the Fedimint card lockup (brand/lockup/fedimint-card-lockup-on-dark.svg): x 230 to 793, y 56 to 131. */
const FEDIMINT_WORD = 'M238 130V92H230V80H238V75Q238 67 242 62Q246 58 255 58Q259 58 262 59Q266 60 268 61L263 72Q261 72 260 71Q259 71 258 71Q256 71 255 72Q253 74 253 78V80H265V92H253V130ZM294 131Q286 131 280 128Q274 124 270 118Q267 113 267 105Q267 97 270 91Q274 85 280 82Q286 79 294 79Q301 79 307 82Q312 85 316 92Q319 99 319 109H283Q284 113 287 116Q290 118 294 118Q298 118 300 117Q303 115 304 112L318 117Q316 122 312 125Q308 128 304 129Q299 131 294 131ZM284 98H303Q302 95 301 94Q299 92 297 91Q295 90 293 90Q291 90 289 91Q287 92 286 94Q284 95 284 98ZM344 131Q337 131 332 128Q327 125 324 119Q321 113 321 105Q321 97 324 91Q327 85 332 82Q337 79 344 79Q348 79 352 80Q355 82 358 86V60H373V130H359L358 123Q356 127 352 129Q348 131 344 131ZM348 117Q351 117 353 115Q355 114 356 112Q358 109 358 106V103Q358 100 356 98Q355 96 353 94Q350 93 348 93Q345 93 342 94Q340 96 339 99Q337 101 337 105Q337 108 339 111Q340 114 342 115Q345 117 348 117ZM383 130V80H398V130ZM390 73Q387 73 384 71Q382 68 382 65Q382 61 384 58Q387 56 390 56Q394 56 397 58Q399 61 399 65Q399 68 397 71Q394 73 390 73ZM407 130V80H422L423 86Q425 82 428 80Q432 79 436 79Q442 79 447 81Q451 84 453 89Q455 84 459 81Q463 79 468 79Q477 79 481 84Q486 90 486 101V130H470V104Q470 100 469 98Q469 95 467 94Q465 93 463 93Q459 93 457 96Q454 98 454 103V130H439V104Q439 100 438 98Q437 95 435 94Q434 93 432 93Q427 93 425 96Q423 98 423 103V130ZM494 130V80H510V130ZM502 73Q499 73 496 71Q493 68 493 65Q493 61 496 58Q499 56 502 56Q506 56 508 58Q511 61 511 65Q511 68 508 71Q506 73 502 73ZM519 130V80H534L534 86Q537 83 540 81Q544 79 548 79Q554 79 559 81Q563 83 565 88Q567 93 567 101V130H551V104Q551 100 550 98Q549 95 548 94Q546 93 544 93Q539 93 537 96Q535 98 535 103V130ZM596 131Q587 131 582 127Q578 122 578 115V93H570V80H578V64H594V80H605V93H594V111Q594 114 595 115Q596 116 598 116Q599 116 600 116Q602 116 603 115L608 126Q606 128 602 130Q599 131 596 131Z';
const FEDIMINT_CARD = 'M638 131Q630 131 625 128Q619 124 616 118Q613 112 613 105Q613 97 616 91Q619 85 625 82Q630 79 638 79Q645 79 651 82Q656 85 659 91L652 94Q650 90 646 88Q642 86 637 86Q633 86 629 88Q625 91 623 95Q621 99 621 105Q621 110 623 114Q625 119 629 121Q633 124 638 124Q643 124 646 121Q650 119 652 114L660 117Q657 124 651 127Q645 131 638 131ZM683 131Q675 131 670 127Q665 123 665 116Q665 108 670 104Q675 100 684 100H698Q697 93 694 89Q691 86 685 86Q681 86 678 87Q675 89 673 93L666 90Q668 86 671 84Q674 81 677 80Q681 79 685 79Q692 79 697 81Q701 84 704 89Q706 95 706 103L706 130H698L698 123Q696 127 692 129Q688 131 683 131ZM684 124Q688 124 691 122Q695 120 696 117Q698 113 698 109V107H686Q679 107 676 109Q673 111 673 116Q673 119 676 122Q679 124 684 124ZM717 130V80H725V89Q728 84 732 82Q737 80 742 80V87Q738 87 734 89Q730 90 727 93Q725 97 725 102V130ZM768 131Q761 131 756 128Q751 124 748 118Q746 112 746 105Q746 97 748 91Q751 85 756 82Q761 79 768 79Q774 79 778 81Q782 84 785 88V60H793V130H785L785 121Q782 126 778 128Q774 131 768 131ZM770 124Q774 124 778 121Q781 119 783 115Q785 110 785 105V104Q785 99 783 95Q781 91 778 88Q774 86 770 86Q765 86 761 88Q758 91 756 95Q754 99 754 105Q754 110 756 115Q758 119 762 121Q765 124 770 124Z';
/** The Fedimint card mark's heptagon and spokes, in its 100 by 76 box (brand/mark/fedimint-card-mark.svg). */
const HEPTAGON = '50,23 61.73,28.65 64.62,41.34 56.51,51.51 43.49,51.51 35.38,41.34 38.27,28.65';
const SPOKES = 'M50 23V-48.25M61.73 28.65L120.38-14.35M64.62 41.34L137.72 61.79M56.51 51.51L89.06 122.81M43.49 51.51L10.94 122.81M35.38 41.34L-37.72 61.79M38.27 28.65L-20.38-14.35';

const stops = (list) => list.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`).join('');

/** The Cashu card mark, cut as the brand draws it, in a 100 by 100 box: its mask, once per face. */
const cashewCut = (id) =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><g transform="rotate(-14 50 50)"><path d="${CASHEW}" fill="#fff"/><g fill="none" stroke="#000" stroke-width="3.4"><rect x="30" y="34" width="24" height="30" rx="5"/><path d="M-2 42H30M-2 56H30M54 40H102M42-2V34M42 64V102"/></g></g></mask>`;

/**
 * The Cashu card's face, w wide (the card's own 1.59 to 1 shape), its top left at (x, y). p: the
 * drawing's id prefix, so two faces on one screen never share a gradient or a mask.
 */
export function cashuFace(p, { x = 0, y = 0, w = 140 } = {}) {
  const s = w / 140;
  return `<defs><linearGradient id="${p}cg" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#DCF4A3'], [0.5, '#9FCA85'], [1, '#568E67']])}</linearGradient><linearGradient id="${p}cc" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#F0E2A4'], [0.45, '#DCC57A'], [1, '#B39748']])}</linearGradient>${cashewCut(`${p}cm`)}</defs>
<g transform="translate(${x} ${y}) scale(${s})">
<rect width="140" height="88" rx="6" fill="url(#${p}cg)"/>
<rect width="100" height="100" fill="#2F6A43" opacity="0.28" mask="url(#${p}cm)" transform="translate(77 13) scale(0.56)"/>
<rect width="100" height="100" fill="#10271E" mask="url(#${p}cm)" transform="translate(9.6 7.6) scale(0.09)"/>
<g transform="translate(9.3 8.1) scale(0.0673)"><path d="${CASHU_WORD}" fill="#10271E"/><path d="${CASHU_CARD}" fill="#557A62"/></g>
<rect x="10.2" y="30.7" width="28.7" height="21.6" rx="3.2" fill="url(#${p}cc)"/>
<g fill="none" stroke="#B9DC93" stroke-width="0.9" stroke-linecap="round"><path d="M10.6 38.2H18.2M10.6 45.2H18.2M30.9 38.2H38.5M30.9 45.2H38.5M23.6 30.9V35M24.6 48.5V52.1"/><path d="${CASHEW}" transform="translate(16.6 33.4) scale(0.155) rotate(-14 50 50)" stroke-width="5.8"/></g>
<g fill="none" stroke="#1E3A2A" stroke-width="1.2" stroke-linecap="round"><path d="M43.8 37.4a3.6 3.6 0 0 1 0 5.2M46.6 35.4a6.6 6.6 0 0 1 0 9.2M49.4 33.6a9.4 9.4 0 0 1 0 12.8"/></g>
<text x="10" y="79.6" font-family="Inter, system-ui, sans-serif" font-size="4.4" font-weight="700" letter-spacing="0.9" fill="#1F3A2A">CASHU ECASH CARD</text>
</g>`;
}

/** The Fedimint card's face, as cashuFace. */
export function fedimintFace(p, { x = 0, y = 0, w = 140 } = {}) {
  const s = w / 140;
  return `<defs><linearGradient id="${p}fg" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#3A62C2'], [0.5, '#213D83'], [1, '#152550']])}</linearGradient><linearGradient id="${p}fm" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="76">${stops([[0, '#F4E9B0'], [0.45, '#D2BB6A'], [1, '#A88A3C']])}</linearGradient><linearGradient id="${p}fc" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#8A7444'], [0.5, '#6A5530'], [1, '#4A3B1F']])}</linearGradient><mask id="${p}fk" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120"><rect x="1" y="1" width="98" height="74" rx="13" fill="#fff"/><g stroke="#000" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="${HEPTAGON}"/><path d="${SPOKES}"/></g></mask></defs>
<g transform="translate(${x} ${y}) scale(${s})">
<rect width="140" height="88" rx="5" fill="url(#${p}fg)"/>
<rect x="-10" y="-10" width="120" height="120" fill="url(#${p}fm)" mask="url(#${p}fk)" transform="translate(9.8 8.4) scale(0.089)"/>
<g transform="translate(6.2 6) scale(0.0644)"><path d="${FEDIMINT_WORD}" fill="#EEF3FF"/><path d="${FEDIMINT_CARD}" fill="#B9C8EE"/></g>
<rect x="15.2" y="29.8" width="18.3" height="14.2" rx="2" fill="url(#${p}fc)"/>
<g fill="none" stroke="#2E2412" stroke-opacity="0.75" stroke-width="0.55" stroke-linecap="round" stroke-linejoin="round"><path d="M15.4 34.4H21.6L22.8 36.9H26.4L27.6 34.4H33.3M15.4 39.6H21.6L22.8 37.1M33.3 39.6H27.6L26.4 37.1M24.6 29.9V34.4M24.6 39.6V44"/></g>
<rect x="15.2" y="29.8" width="18.3" height="14.2" rx="2" fill="none" stroke="#FFFFFF" stroke-opacity="0.25" stroke-width="0.5"/>
<g fill="none" stroke="#E8EDFB" stroke-width="1.2" stroke-linecap="round"><path d="M43.8 36.8a3.8 3.8 0 0 1 0 5.6M46.8 34.6a7 7 0 0 1 0 10M49.8 32.6a10 10 0 0 1 0 14"/></g>
<text x="9.9" y="80.2" font-family="Inter, system-ui, sans-serif" font-size="4.6" font-weight="700" letter-spacing="1" fill="#EFF1FE">FEDIMINT ECASH CARD</text>
</g>`;
}

export const FACES = { card: cashuFace, fedimint: fedimintFace };

let n = 0;

/** A card face on its own: the card screens' picture of the card. With no label it is hidden from screen readers. */
export function cardFace(brand, label = null) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 140 88');
  s.setAttribute('class', 'card-face');
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  s.innerHTML = FACES[brand](`cf${++n}-`).replace(/>\s+</g, '><');
  return s;
}

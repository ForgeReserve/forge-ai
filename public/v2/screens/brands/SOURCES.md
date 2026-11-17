# Sources

`cards.js` draws the Cashu card and the Fedimint card from their makers' own brand files. Nothing here is
invented: the marks and the words are the brands' outlines, rounded to whole units; the faces follow the
printed card art, in the brands' colours. No file is shipped as it was: only the shapes below are copied
into `cards.js`.

| What in `cards.js` | Taken from | Licence |
| - | - | - |
| `CASHEW` and the mark's cut (the chip lines), the colours `#10271E`, `#557A62` | [cashucard/cashucard](https://github.com/cashucard/cashucard) `brand/mark/cashu-card-mark.svg`, `brand/mark/cashu-card-mark-green.svg`, `brand/tokens.css`, commit `b5ffe8a` | MIT, [`public/vendor/licenses/cashucard.txt`](../../../vendor/licenses/cashucard.txt) |
| `CASHU_WORD`, `CASHU_CARD` (the "cashucard" wordmark) | cashucard/cashucard `brand/lockup/cashu-card-lockup-on-light.svg`, commit `b5ffe8a` | MIT, as above |
| The Cashu card face: its lime to green ground, the gold chip with the cashew, the waves, the large mark, "CASHU ECASH CARD" | cashucard/cashucard `apps/provisioner/assets/cardart/cashu-card-front.png`, commit `b5ffe8a` (colours sampled, layout measured) | MIT, as above |
| `HEPTAGON`, `SPOKES` and the mark's gold gradient | [fedimintcard/fedimintcard.org](https://github.com/fedimintcard/fedimintcard.org) `brand/mark/fedimint-card-mark.svg`, commit `f3ebaac` | MIT, [`public/vendor/licenses/fedimintcard.txt`](../../../vendor/licenses/fedimintcard.txt) |
| `FEDIMINT_WORD`, `FEDIMINT_CARD` (the "fedimintcard" wordmark) | fedimintcard/fedimintcard.org `brand/lockup/fedimint-card-lockup-on-dark.svg`, commit `f3ebaac` | MIT, as above |
| The Fedimint card face: its blue to night ground, the chip, the waves, "FEDIMINT ECASH CARD" | [fedimintcard/fedimintcard](https://github.com/fedimintcard/fedimintcard) `ios-pos/FedimintCardPOS/Resources/card_front.png`, commit `957b19b` (colours sampled, layout measured) | MIT (Copyright 2026 The fedimint-card authors) |

Both brand kits ask that a mark keep its shape, angle and gradient. The marks are drawn as given; the
large Cashu mark at low opacity is the one printed on the Cashu card itself. The tab icons on Add money
(`screens/wallet-art.js`) are the app's own line icons with a plain cashew or heptagon where a chip would
be; they are not the marks.

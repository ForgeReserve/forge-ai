# Look modules

A look module sets the app's colours. It is a set of design tokens: one colour or shadow for each named part of the screen. The person picks a look in More, Mode and look. The app ships with three: Midnight (the default), Light and Dark.

Read [the overview](README.md) first. The bundled looks are in [`public/v2/modules/look/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/look) and described in the [module list](list.md#look). [Write your first module](first-module.md#a-look-high-contrast) builds one step by step.

## Manifest

`kind` is `look`. The other fields follow [the manifest rules](README.md#the-manifest).

## Inputs

A look gets no inputs. `create()` is called with an empty frozen object.

```js
look: [],
```

## What a look provides

### `id`

Required. A short name such as `'midnight'`. The settings keep it when the person picks the look, and it names the look's two strings, `look.<id>.name` and `look.<id>.sub`, which More, Mode and look shows. Both must be in the string table.

### `scheme`

Required. `'light'` or `'dark'`. The app sets it as the page's colour scheme (`data-scheme` and `color-scheme` on the root element), so the browser's own controls and scroll bars match.

### `tokens`

Required. An object from token name to a CSS value. The app sets each one on the root element as a custom property: `bg` becomes `--bg`, which `style.css` uses everywhere.

```js
function setTokens(tokens, scheme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--${k}`, v);
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.bg);
}
```

Give every token the bundled looks have. The app sets only the tokens a look names, so a token left out keeps the value of the look shown before. The bundled looks have these 51:

| Group | Tokens | What they colour |
| - | - | - |
| Grounds | `bg`, `backdrop`, `surface`, `surface-2` | The page, the ground behind full-screen panels, cards and buttons, inner panels and code |
| Text | `ink`, `text-2`, `text-body` | Headings and labels, quieter lines, running text |
| Lines | `line`, `line-2`, `bar-track`, `grabber`, `dash` | Edges, stronger edges, empty bars, a sheet's handle, radio rings, switches and dashed boxes |
| Memory and private | `teal`, `teal-tint`, `teal-line`, `teal-bright`, `memory`, `memory-track` | The memory ring and its track, private marks |
| Funds | `gold`, `gold-track`, `gold-ink`, `gold-line`, `gold-callout`, `gold-tint`, `gold-free` | The funds ring and its track, money text, the edges of money notices, free questions on the ring |
| Warnings | `danger`, `danger-tint`, `danger-ink`, `low`, `low-tint`, `low-line`, `low-ink` | Errors and Burn; low memory and Standard models |
| Accents | `blue`, `blue-tint`, `violet`, `violet-tint`, `green`, `green-tint` | Tinted icon tiles and tags |
| Buttons | `primary`, `primary-ink`, `talk`, `talk-ink` | The main button and the talk button, and the text on them |
| Depth | `shadow-raised`, `shadow-raised-sm`, `shadow-primary`, `shadow-talk`, `shadow-float` | CSS `box-shadow` values for raised parts, buttons and floating cards |
| Focus | `focus` | The keyboard focus ring |

`bg` also colours the browser's bar (the `theme-color` meta) and, in the Android app, the phone's status and navigation bars. The thumbnail on More, Mode and look draws `bg`, `line`, `gold-track`, `gold`, `memory-track`, `memory`, `talk` and `surface`; it takes only plain hex colours there and draws grey for anything else.

## Lifecycle

1. The registry calls `create()` once when the app starts. On the first run the looks are among the first modules loaded.
2. `applyLook` in [`public/v2/app.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/app.js) sets the chosen look's tokens: at start, when the person picks a look, and when the phone switches between light and dark while Follow the phone is on.
3. The app keeps the look's tokens in `localStorage` (`forge2.look`), so the next start paints its first frame in that look before any module loads. The website's `/free` and `/download` pages use the same kept tokens ([`public/v2/core/pagelook.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/pagelook.js)).

## Errors

A `create` that throws gets the look refused, and it is not listed. A look id the settings name and the registry does not have falls back to Midnight, then to the first look loaded.

## How the app lists and orders them

More, Mode and look ([`public/v2/screens/settings.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/settings.js)) lists every look in the order of `BUNDLED`, each with its thumbnail, `look.<id>.name` and `look.<id>.sub`. Follow the phone uses only the bundled ids: Light while the phone is light, and Midnight or Dark while it is dark.

```js
if (S.settings.followSystem) id = darkQuery?.matches ? (S.settings.look === 'midnight' ? 'midnight' : 'dark') : 'light';
```

## Platforms

A look works the same on the website and in both apps. The Android app colours the phone's bars from `bg`; the iPhone app sets the status bar's text dark or light from it.

## A minimal look

The High contrast look from [Write your first module](first-module.md#a-look-high-contrast): black on white, with dark colours and solid edges. It is [`docs/modules/examples/look/contrast/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples/look/contrast); its `index.js` is shown in full in the guide. Its `manifest.json`:

```json
{
  "id": "org.example.look.contrast",
  "kind": "look",
  "version": "1.0.0",
  "name": {
    "en": "High contrast"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

It needs two strings in [`public/v2/strings/en.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/strings/en.js):

```js
  'look.contrast.name': 'High contrast',
  'look.contrast.sub': 'Black on white, for easy reading.',
```

## Tests

[`test/unit/v2/copy-and-looks.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/copy-and-looks.test.ts) checks that every bundled look has the same tokens and keeps text at a contrast of 4.5 to 1 or more. Run the same checks on a new look. [`test/ui/midnight.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/midnight.ui.test.ts) opens every screen in Midnight and checks for text that reads too faintly.

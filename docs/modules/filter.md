# Filter modules

A filter module checks a photo in Share unseen before it is shared. It finds hidden details in the file to take out, or places in the picture to cover with solid blocks: faces, writing, a number plate. Every filter runs on every photo, one after another, on the phone.

Read [the overview](README.md) first. The bundled filters are in [`public/v2/modules/filter/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/filter) and described in the [module list](list.md#filter). [Write your first module](first-module.md#a-filter-cover-a-date-stamp) builds one step by step.

## Manifest

`kind` is `filter`. The other fields follow [the manifest rules](README.md#the-manifest).

## Inputs

A filter gets one input when it is made. The photo itself comes later, with each call to `analyse`.

```js
filter: ['t'],
```

### `t`

`t(key, params)` returns the text for `key` from the string table. See [Fund](fund.md#t).

## The photo

`analyse(photo)` gets the photo the person picked or took, opened on the phone by `openPhoto` in [`public/v2/core/photo.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/photo.js):

| Field | What it is |
| - | - |
| `width`, `height` | The size of the working picture, at most 2,048 pixels on its long side, turned the way the camera meant. |
| `canvas` | A canvas holding the working picture. |
| `pixels` | Its `ImageData`: `{width, height, data}`, four bytes per pixel (red, green, blue, alpha). |
| `bytes` | The original file as a `Uint8Array`. Only the hidden details filter reads it. |
| `type` | The file's type, such as `image/jpeg`. |

Blocks are in the working picture's pixels.

## What a filter provides

### `id`

Required. A short name such as `'cover-faces'`. Each step row on the screen and each block a filter makes carries it.

### `what`

Required. What the filter looks for: `'details'`, `'faces'` or `'writing'`. The step row's words are the string `photo.step.<what>`, and the list of changes groups blocks by it. A new value needs its own `photo.step.<what>` string, and its blocks are painted and left out of the list of changes; use one of the three.

### `analyse(photo)`

Required. Looks at the photo and resolves:

| Field | What it is |
| - | - |
| `covers` | Blocks to paint: `[{x, y, w, h, kind}]` in the photo's pixels. `kind` is `'face'` or `'writing'`; without it a `faces` filter's blocks are faces and any other's are writing. Blocks are cut to the photo and empty ones dropped. |
| `found` | For a `details` filter: the hidden details the original file holds, from `'location'`, `'device'`, `'time'`, `'thumbnail'` and `'other'`. |
| `known` | For a `details` filter: `false` when it could not read the file's details at all. |

Resolve `{covers: []}` when there is nothing to cover.

### `finish(bytes)`

Optional. After the person picks Share, Save or Ask about it, the app draws the photo again with every block painted solid, makes a new JPEG, and hands its bytes to each filter's `finish` in turn. Return the cleaned bytes (a `Uint8Array`, or a promise of one). The hidden details filter takes every place for notes out of the JPEG here.

### `prepare()`

Optional. Starts slow work early, such as loading a model. The app calls it once, shortly after Share unseen opens, and ignores its errors. Return a promise.

## Lifecycle

1. The registry calls `create(inputs)` once when the app starts.
2. Share unseen opens: after 300 ms the app calls `prepare()` on every filter that has one.
3. The person picks or takes a photo, or shares one in from another app. The app runs `analyse(photo)` on each filter in turn, through `runFilters` in [`public/v2/core/filters.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/filters.js), and shows each step as it runs.
4. The person sees the photo before and after, with every block. They can take blocks away and add their own.
5. Share, Save or Ask about it: the app paints the blocks into a new JPEG, calls each `finish(bytes)` in turn, and checks that the file holds no hidden details before it goes anywhere.

## Errors

- A filter that throws, rejects or takes longer than 45 seconds is listed as not checked, and the chain goes on with the next one. Before the photo is shared the person is told a check did not run and taps again to share anyway.
- A `finish` that throws stops the photo from being shared; the app shows its `photo.shareFailed` words.
- The app checks the final file with `leftDetails` in [`public/v2/core/photometa.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/photometa.js). A `finish` that puts details back makes the app refuse the file with its `photo.unsafe` words.

## How the app lists and orders them

Share unseen ([`public/v2/screens/photo.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/photo.js)) runs every loaded filter, in the order of `BUNDLED`:

```js
// Share unseen runs the filters in this order: hidden details, then faces, then writing.
{ kind: 'filter', folder: 'strip-details' },
{ kind: 'filter', folder: 'cover-faces' },
{ kind: 'filter', folder: 'cover-numbers' },
```

There is no setting to turn a filter off. A filter added after these runs last.

## Platforms

Share unseen works the same on the website, in the Android app and in the iPhone app. A filter sees only the photo object. The photo comes from the camera or the gallery, or from another app's share sheet: through the web app's share target on the website, and through the app itself on Android.

The iPhone app serves its files from `capacitor://localhost`, not from an `https://` address. A filter that loads a file of its own, such as a model, makes its address with `new URL(name, import.meta.url)` and hands it to `fetch` whole. Do not let a library rebuild the address: face-api's `loadFromUri` keeps only `http://` and `https://` addresses whole, so in the iPhone app it asked for `capacitor:/localhost/...` and the face check never ran. The face filter fetches its model's manifest itself and hands the weights to face-api (`loadModel` in `cover-faces/index.js`).

## A minimal filter

This filter covers the orange date some cameras print on a photo. It is [`docs/modules/examples/filter/date-stamp/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples/filter/date-stamp), and [Write your first module](first-module.md#a-filter-cover-a-date-stamp) builds it step by step. Its `manifest.json`:

```json
{
  "id": "org.example.filter.date-stamp",
  "kind": "filter",
  "version": "1.0.0",
  "name": {
    "en": "Cover a date stamp"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

Its `index.js` is shown in full in the guide. The part the app calls:

```js
export function create() {
  return {
    id: 'date-stamp',
    what: 'writing',
    async analyse(photo) {
      const box = findStamp(photo.pixels);
      return { covers: box ? [{ kind: 'writing', ...box }] : [] };
    },
  };
}
```

## Tests

[`test/unit/v2/photo.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/photo.test.ts) tests the filter chain with fake filters, the writing finder and the details reader on real camera files in `test/unit/fixtures/photos/`. [`test/ui/photo.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/photo.ui.test.ts) picks a photo in Chrome and checks the blocks and the list of changes. [`test/unit/v2/face-model.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/face-model.test.ts) loads the face model with the real face-api from the website's, the Android app's and the iPhone app's addresses, and [`test/unit/ios.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/ios.test.ts) checks that the iPhone app carries every file the filters load.

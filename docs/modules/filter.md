# Filter modules

A filter module checks a photo in Share unseen before it is shared. It finds hidden details in the file to take out, or places in the picture to cover: faces, writing, a number plate. Every filter runs on every photo, one after another, on the phone.

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

Covers are in the working picture's pixels. The new file is made at that size too, so a cover lands on the same pixels on the screen and in the file.

## What a filter provides

### `id`

Required. A short name such as `'cover-faces'`. Each step row on the screen and each block a filter makes carries it.

### `what`

Required. What the filter looks for: `'details'`, `'faces'` or `'writing'`. The step row's words are the string `photo.step.<what>`, and the list of changes groups blocks by it. A new value needs its own `photo.step.<what>` string, and its blocks are painted and left out of the list of changes; use one of the three.

### `analyse(photo)`

Required. Looks at the photo and resolves:

| Field | What it is |
| - | - |
| `covers` | Covers to paint, in the photo's pixels: a box `{x, y, w, h, kind}`, or an ellipse `{shape: 'ellipse', cx, cy, rx, ry, x, y, w, h, kind}` whose `x`, `y`, `w` and `h` are its bounds. `kind` is `'face'` or `'writing'`; without it a `faces` filter's covers are faces and any other's are writing. `found`, optional, is the box of what the filter found (the face, the line of writing), which the cover holds; tests check it. Covers are cut to the photo and empty ones dropped. |
| `maybe` | Optional. Places the filter was not sure enough of to cover, as covers like those in `covers`: small or blurred faces in a crowd. They are not painted. The screen says what may have been missed and offers to cover them with one tap; they then count as the person's own blocks. A filter that covered nothing but has places in `maybe` is listed as Not sure. |
| `found` | For a `details` filter: the hidden details the original file holds, from `'location'`, `'device'`, `'time'`, `'thumbnail'` and `'other'`. |
| `known` | For a `details` filter: `false` when it could not read the file's details at all. |

Resolve `{covers: []}` when there is nothing to cover.

### `finish(bytes)`

Optional. After the person picks Share, Save or Ask about it, the app draws the photo again with every cover painted (see [How covers are painted](#how-covers-are-painted)), makes a new JPEG, and hands its bytes to each filter's `finish` in turn. Return the cleaned bytes (a `Uint8Array`, or a promise of one). The hidden details filter takes every place for notes out of the JPEG here.

### `prepare()`

Optional. Starts slow work early, such as loading a model. The app calls it once, shortly after Share unseen opens, and ignores its errors. Return a promise.

## Lifecycle

1. The registry calls `create(inputs)` once when the app starts.
2. Share unseen opens: after 300 ms the app calls `prepare()` on every filter that has one.
3. The person picks or takes a photo, or shares one in from another app. The app runs `analyse(photo)` on each filter in turn, through `runFilters` in [`public/v2/core/filters.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/filters.js), and shows each step as it runs.
4. The person sees the photo before and after, with every cover. They can take a cover away with the cross on its corner, or a tap on it, and add their own by tapping or dragging on the photo.
5. Share, Save or Ask about it: the app paints the covers into a new JPEG, calls each `finish(bytes)` in turn, and checks that the file holds no hidden details before it goes anywhere.

## How covers are painted

`paintCovers` in [`public/v2/core/covers.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/covers.js) paints them, for the screen and for the file alike:

- Every pixel a cover touches is painted whole. There is no soft edge that keeps part of what was under it.
- Each cover is one flat colour: the middle value of red, green and blue over a thin ring of pixels just outside it (about 4 pixels wide on a 1,000 pixel photo), counting only pixels under no cover. So it reads as a smudge, not a black bar, and the colour is made only of pixels the new file shows anyway.
- A cover is never blurred or pixelated: a blurred face or line of writing can be sharpened or matched. Nothing under a cover reaches the new file in any form; a test changes every pixel under the covers and gets the same file, byte for byte.

On the screen each cover also has a gold outline and a cross on its corner to take it away. The file has neither.

The face filter fits an ellipse round each face: it reaches half the detector's box height above the box for the hair, three tenths of its width to each side for the ears and three tenths of its height below it for the chin, plus a tenth of the box's size (at most 4 pixels) and two of the detector's pixels at its look at the whole photo, and up to 15% more for a face the detector was not sure of. The writing filter fits a box to each line it finds, with a margin of about a third of a letter's height, and reaches along the line to letters it did not take for letters alone (letters run together, a bare I or 1). It joins two lines into one box only where that box covers little more than the two do.

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

The iPhone app serves its files from `capacitor://localhost`, not from an `https://` address. A filter that loads a file of its own, such as a model, makes its address with `new URL(name, import.meta.url)` and hands it to `fetch` whole. Do not let a library rebuild the address: face-api's `loadFromUri` keeps only `http://` and `https://` addresses whole, so in the iPhone app it asked for `capacitor:/localhost/...` and the face check never ran. The face filter fetches its model's files itself and hands the weights to TensorFlow.js (`loadYunet` in `cover-faces/yunet.js`).

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

## How the face filter finds small faces

The face filter runs YuNet, a face detector made for small faces (MIT, from the [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)), on the TensorFlow.js that the vendored face-api bundles. [`scripts/yunet-model.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/scripts/yunet-model.ts) turns its ONNX file, pinned by commit and SHA-256, into `public/vendor/yunet/`: the list of layers and about 100 KB of 16-bit weights. No ONNX runtime is shipped. `node scripts/yunet-model.ts --check` checks that the committed files are what the pinned file gives.

YuNet finds faces from about 10 of its own pixels across. `passes` in `cover-faces/boxes.js` decides where it looks:

1. The whole photo, made to fit one 640 pixel tile: faces too large for a tile.
2. Overlapping 640 pixel tiles over all of the photo, at a zoom that brings its long side to 2,048 pixels, at most twice its size. A 1,280 pixel photo is looked at 1.6 times its size, so a face 12 pixels across reaches the detector at 19. Neighbouring tiles share a fifth of a tile.
3. At most 12 tiles. A photo that would take more (a square one) is looked at a little smaller, so every part of it is still looked at.

On a phone with no graphics chip to use, TensorFlow.js runs on the processor, and the tiles are at the photo's own size: about half the work.

Finds scored 0.6 and up, at least 10 pixels across in the photo, are covered. Finds from 0.5 up to 0.6 that meet no covered face are the filter's `maybe`.

### Scoring it

[`scripts/face-score.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/scripts/face-score.ts) runs a face filter in Chrome on the crowd photos in `test/unit/fixtures/photos/crowd/`, whose faces are marked by hand in `faces.json`, and prints per photo how many marked faces its covers hold (recall), how many face covers land on no face (false), how many spots it was not sure of, and the time `analyse` took:

```sh
node scripts/face-score.ts                  # the bundled filter
node scripts/face-score.ts --throttle 4     # processor 4 times slower, a stand-in for a low-end phone
node scripts/face-score.ts --cpu            # no WebGL: TensorFlow.js on the processor
node scripts/face-score.ts --filter <folder> --runs 3 --json
```

A face is covered when 90% of its marked box is under covers. A face is marked when it is at least 12 pixels tall and a person could tell who it is: looking at the camera, turned or in profile. The back of a head does not count. Places a cover is neither right nor wrong (faces too blurred, hidden or turned to call, visors) are marked as `ignore`. `--throttle` slows the page's processor only; a graphics chip runs at its own speed.

On the ten crowd photos (304 faces), on a Mac:

| Finder | Covered | False covers | Time per photo, graphics chip | Processor only, 4 times slower |
| - | - | - | - | - |
| face-api's tiny face detector, whole photo and four quarters (before) | 39 (13%) | 5 | about 0.1 s | about 10 s |
| The same detector in 256 pixel tiles, about 35 of them | 163 (54%) | 21 | about 0.7 s | about 80 s |
| The same in at most 12 tiles | 78 (26%) | 10 | about 0.2 s | about 26 s |
| YuNet in tiles (now) | 291 (96%) | 30 | about 0.2 s | about 15 s (tiles at the photo's own size: 284, 93%) |

Most false covers are the backs of heads, hands and a face drawn on a sign. Covering the spots the filter was not sure of covers 4 more faces.

## Tests

[`test/unit/v2/photo.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/photo.test.ts) tests the filter chain with fake filters, the writing finder and the details reader on real camera files in `test/unit/fixtures/photos/`. [`test/ui/photo.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/photo.ui.test.ts) picks a photo in Chrome and checks the blocks and the list of changes. [`test/unit/v2/face-model.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/face-model.test.ts) loads the face model with the real TensorFlow.js from the website's, the Android app's and the iPhone app's addresses and finds the three faces in the crew photo, the UI test checks that every face in the wide protest photo is covered on the Share unseen screen, and [`test/unit/ios.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/ios.test.ts) checks that the iPhone app carries every file the filters load.

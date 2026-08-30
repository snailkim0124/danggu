# lib/vision

Vision Recognition module — table + ball detection from an uploaded photo, using OpenCV.js (WASM).

Implements PRD "테이블·공 자동 인식(Vision Recognition)" / plan Phase 1. Entry point:

```ts
import { recognize } from '@/lib/vision';

const { recognition, pixelDetection, diagnostics } = await recognize(image, settings);
```

`recognition` is a `RecognitionResult` from `lib/types.ts`. Import from the `@/lib/vision`
barrel, not from individual files.

## Pipeline

| Step | File | What it does |
|---|---|---|
| 1. Downscale | `image.ts` | Area-average resample to ≤1600px on the long side, before any CV work |
| 2. Cloth segmentation | `cloth.ts` | Per-photo dominant-hue estimate → HSV mask |
| 3. Table boundary | `table.ts` | Four cushion lines fitted by TLS, intersected pairwise |
| 4. Homography + pose | `camera.ts` | 4-point DLT, focal length and camera position recovered from the same homography |
| 5. Ball detection | `balls.ts` | Holes in the cloth mask → robust circle fit → **z=radius reprojection** |
| 6. Colour classification | `balls.ts` | Relative white/yellow/red assignment, no absolute thresholds |
| 7. Confidence | `confidence.ts` | Five conjunctive factors → `needsManualCorrection` |

`geometry.ts` holds the pure-maths primitives (lines, homographies, circle fitting).
`opencv.ts` loads and caches the WASM module and tracks Mat lifetimes.
`synthetic.ts` renders ground-truthed test scenes.

## Design decisions worth knowing

**Table boundary comes from four fitted lines, never from corner points.** The plan requires a
corner cropped out of frame to remain recoverable, and an extrapolated line intersection gives
that for free. Contour points sitting on the image border are discarded before fitting, since
that part of the outline is the frame edge rather than a cushion. A cushion that is *entirely*
out of frame is rejected with a clear error rather than silently fitted to the image border —
four partly-visible cushions are required, which is a weaker condition than four visible corners.

**Cloth colour is measured per photo, not hardcoded.** Cloth ranges from blue-green to blue and
hall lighting shifts the measured hue substantially, so the dominant hue is taken from a
chroma-weighted histogram of the image itself and the saturation/value bounds come from
percentiles of the pixels around that peak.

**Ball positions are reprojected to the z=ball-radius plane.** This is plan Risk R2. A ball's
centre sits ~30.75mm above the cloth, so the cloth-plane homography places it tens of
millimetres too far from the camera — 60-90mm for a phone held low, which is more than a ball's
width of aiming error. `diagnostics.parallaxCorrectionMm` reports the per-ball magnitude so the
correction's effect stays observable in production rather than only in tests.

**White vs. yellow is decided relatively.** Under warm tungsten a white ball's raw colour is more
yellow than a yellow ball's under LED. All six red-pair hypotheses are scored on relations that
hold under any lighting (the reds agree in hue with each other, white is the least colourful,
yellow is less blue than white), and the margin over the runner-up feeds the confidence score.

**Confidence is a weighted geometric mean, not an average.** The factors are conjunctive: a
perfect table fit cannot compensate for a coin-flip colour assignment, because a cue-ball swap
makes every recommendation wrong while still looking normal. Any near-zero factor collapses the
whole score, which routes the user to the correction screen.

## Coordinate conventions

- **Table (mm):** X along the long cushion `0..widthMm`, Y along the short cushion `0..heightMm`,
  origin at a cushion-nose corner, Z up out of the cloth.
- **Image (px):** x right, y down, in the space of the **downscaled** image
  (`pixelDetection.imageWidth`/`imageHeight`). Scale by `originalWidth / imageWidth` to overlay
  on the original upload.
- The image↔table correspondence is orientation-*reversing* (y-down image vs. y-up table plane).
  `alignQuadToTable` handles this; getting it backwards recovers a camera below the cloth.

## Dependencies

- `@techstark/opencv-js` — loaded via `createRequire`, not a static import: its CommonJS exports
  object is a Promise, which makes the ESM namespace thenable and breaks any loader that awaits
  it. Listed in `serverExternalPackages` (see `next.config.ts`); Node runtime only, never Edge.
- `sharp` — image decoding/encoding only, resolved by dynamic `import()` so it never enters a
  client bundle. Callers holding decoded pixels can skip it entirely by passing an `RgbaImage`
  (the `raw` request form on `/api/recognize`).

## Known limitations

- Requires all four cushions at least partly visible; a fully-cropped cushion is rejected.
- Balls touching or occluding each other merge into one connected blob, which
  `balls.ts#trySplitMergedBlob` now attempts to split with a locally-restricted `HoughCircles`
  pass before giving up — works well once each ball is at least roughly 20px in radius (a
  reasonably close photo), but a whole-table shot from far enough away that balls render only
  ~10-15px can still fail to split; the manual-correction screen is the fallback either way.
  Two failure modes of that split were found and fixed from a real photo (`scripts/fixtures/photos/에러1.jpg`,
  `lib/vision/realPhotos.test.ts`): a ball's own cast shadow could get fit as a second, spurious
  circle (now rejected — a real ball is never anywhere near as dark as a shadow on cloth, checked
  relative to the brightest circle found in the same blob, not an absolute cutoff), and — a
  pre-existing issue in the single-ball path too, unrelated to that split — a glare speck or dust
  fleck excluded from the cloth mask on saturation/value alone can still fit a plausible ball-sized
  circle whose colour sample, once averaged with the ordinary felt around it, reads as essentially
  cloth-coloured (now rejected by hue proximity to the segmented cloth's own hue). The `minDist`
  tension between "two genuinely touching balls" and "one ball found twice by Hough" is narrow
  (~1.2x a ball's radius apart for a real duplicate vs. as little as ~1.4x for a genuine pair's
  *apparent* separation under an oblique angle) and only really resolved by scoring+colour, not
  distance alone — see the `minDist`/dedup comments in `trySplitMergedBlob`.
- A neighbouring table of the same cloth colour inside the frame can enlarge the segmented
  region; the `rectangleConsistency` confidence factor is what catches it.
- Ball radius defaults to 65.5mm-diameter Korean 4구 carom balls (matches
  `lib/pathcalc/config.ts`), overridable via `RecognizeOptions.ballRadiusMm`.
- Validated end-to-end only against rendered scenes so far (`synthetic.ts`). Real photos need the
  geometric gate in `scripts/geometric-gate.ts` with user-collected ground truth.
- A real table's cushions are cloth-covered in the same colour as the bed, so `detectTableBoundary`
  cannot find the cushion-nose line (where a ball actually rolls to and bounces) by colour alone —
  it finds the outer rail edge, a real fixed distance further out. `buildTableFrame`'s
  `cushionWidthMm` parameter (default `CUSHION_WIDTH_MM`, `lib/vision/constants.ts`) corrects for
  this by treating the detected quad as the outer rail and expanding the calibration target
  accordingly, so its own `(0,0)..(widthMm,heightMm)` comes out as the true nose line — but the
  correction is a qualitative estimate, not a per-table measurement. The confirm screen shows both
  lines and lets the user drag the nose-line corners to match their own table.
- `estimateIntrinsics`/`fitFocalJointly`'s joint orthonormality objective can have more than one
  near-zero minimum for some camera geometries — found while adding the above correction, which
  shifts the calibration rectangle off the exact 2:1 ratio the objective was mostly exercised
  against before. `rectangleConsistency` alone cannot tell a good fit from one that latched onto
  the wrong minimum (both score ~1.0); a focal length off by several times, or a recovered camera
  centre far from any plausible position, are the symptoms. See the camera-height comment on
  `synthetic-002-long-side` in `scripts/generate-synthetic-fixtures.ts` for a reproducing case.
  Not yet mitigated — a follow-up for the solver itself, not specific to any one caller.

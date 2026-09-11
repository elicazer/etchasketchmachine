# Requirements: Image Tonal Hatching ("Engineezy-style" portraits)

## Introduction

The image-import feature currently offers three trace modes: `edge` (outline),
`centerline` (skeleton), and `shaded` (amplitude-modulated serpentine). The
shaded mode produces a recognizable portrait but two problems remain:

1. It renders tone with a **fixed-wavelength zig-zag** wherever the image is
   dark, which produces a very high step count and many short moves (the motor
   never reaches cruise speed → slow, "incremental" draw).
2. It does not look like the reference target. The reference (Engineezy's
   Etch-a-Sketch portraits) reproduces tone with **horizontal scan lines whose
   local behavior follows local image darkness** — lines run mostly straight,
   deviate only where there is tone, and the line *density / deviation*
   encodes shading. The result is an engraving-like portrait that is both
   cleaner and more drawable.

This feature replaces the shaded mode's tone model with a **per-pixel
density-hatching** generator that matches the reference aesthetic AND lets the
user bound total draw cost.

### Hard lessons already learned (constraints on any solution)

- **Per-row average darkness fails.** Averaging darkness across a whole row
  throws away within-row detail and collapses the portrait into uniform flat
  lines. Tone MUST be driven by **local (per-x) darkness** sampled along each
  scan row.
- **Degenerate bounding box breaks the fit.** If the generated polyline's
  points all share (nearly) one Y or one X, the downstream
  `fitPolylinesToEnvelope` blows up the aspect / collapses the drawing into a
  corner. The generated geometry MUST span a non-degenerate bounding box.
- **Total cost is inherent to dark area.** Rich dark regions need a lot of
  line. There is no "looks great AND tiny step count" for a dark portrait, so
  the user needs an explicit cost control with a predictable effect.

## Glossary

- **Scan row**: one horizontal pass of the serpentine line at a fixed Y band.
- **Local darkness `d(x,y)`**: `(255 - luma) / 255` in `[0,1]`, 1 = black.
- **Hatching**: encoding tone via line modulation along a scan row.
- **Step count / total length**: `Σ max(|dx|,|dy|)` over the planned path
  (the "Total length" readout); the proxy for draw time.
- **Shaded mode**: the `EdgeOptions.mode === 'shaded'` path in
  `web/src/image/image_processor.ts` (`serpentineShade`).

## Requirements

### Requirement 1 — Tone follows local (per-x) darkness

**User story:** As a user importing a photo, I want the drawn lines to follow
the actual light/dark detail across the image, so the portrait is recognizable
(eyes, nose, jaw, hair all distinct), not a field of identical lines.

#### Acceptance Criteria
1.1 WHEN shaded tracing runs THEN the line modulation at horizontal position x
    in a scan row SHALL be a function of the LOCAL darkness `d(x, rowY)` (a
    small neighborhood sample), NOT a row-wide average.
1.2 WHEN two regions in the same scan row differ in darkness (e.g. lit cheek vs.
    shadowed eye socket) THEN the line SHALL visibly differ between them
    (flatter/sparser in the light region, denser/more-deviated in the dark
    region).
1.3 WHEN the source is a recognizable portrait THEN the generated preview SHALL
    remain recognizable as that subject at the default settings.

### Requirement 2 — Engraving-style line behavior (the look)

**User story:** As a user, I want the output to look like the reference
Etch-a-Sketch portraits (clean horizontal hatching), not a uniform scribble.

#### Acceptance Criteria
2.1 WHEN a scan-row region is light (below an ink threshold) THEN the line SHALL
    run essentially straight through it (collapsible by RDP into one long
    segment).
2.2 WHEN a scan-row region is dark THEN tone SHALL be rendered by modulating the
    line (amplitude and/or local frequency) in proportion to darkness so darker
    reads denser.
2.3 WHEN scan rows reverse direction at the image edges THEN the turn SHALL be a
    connected transition (no pen lift), preserving a single continuous path.
2.4 WHEN the whole image is generated THEN it SHALL be ONE continuous polyline
    (serpentine), so connector travel between fragments is effectively zero.

### Requirement 3 — Bounded, predictable draw cost

**User story:** As a user, I want to control how long a drawing takes, with a
control whose effect on step count is predictable.

#### Acceptance Criteria
3.1 WHEN the user lowers the shading-detail control THEN the total step count
    SHALL decrease monotonically (fewer rows / coarser hatching).
3.2 WHEN the user raises contrast THEN dark area (and therefore dense hatching
    and step count) SHALL not increase, and SHALL generally decrease, because
    more mid-tones fall below the ink threshold.
3.3 The generator SHALL expose a way to keep total generated points bounded for
    a given detail setting (no pathological blow-up on a fully-black image).
3.4 WHEN settings are unchanged THEN generation SHALL be deterministic (same
    input image + options → identical polyline).

### Requirement 4 — Non-degenerate, in-envelope geometry

**User story:** As a user, I want the drawing to fill the drawable area
correctly (not collapse into a corner).

#### Acceptance Criteria
4.1 WHEN the generated polyline is produced THEN its bounding box SHALL span
    both axes non-degenerately (width > 0 and height > 0) for any non-empty
    image, so the envelope fit preserves aspect and centers correctly.
4.2 WHEN fitted into the effective envelope THEN every emitted step coordinate
    SHALL remain within `[0, env.x] × [0, env.y]` (existing fit guarantee
    preserved).

### Requirement 5 — Preserve existing modes and pipeline

**User story:** As a user, I still want logos/line art to use the crisp
edge/centerline modes, and I don't want unrelated behavior to change.

#### Acceptance Criteria
5.1 WHEN mode is `edge` or `centerline` THEN behavior SHALL be unchanged.
5.2 WHEN mode is `shaded` THEN the new per-pixel hatching generator SHALL be
    used in place of the old amplitude zig-zag.
5.3 The change SHALL be confined to the web image pipeline
    (`web/src/image/image_processor.ts` + `web/src/ui/ImagePanel.tsx`); no
    firmware change and no wire-protocol change.
5.4 The `toPolylines` adapter seam, decode/downscale, contrast pre-step, and
    `fitPolylinesToEnvelope` SHALL be reused, not duplicated.

### Requirement 6 — Testability

**User story:** As a maintainer, I want this covered by host tests so it does
not regress (it has regressed repeatedly during ad-hoc tuning).

#### Acceptance Criteria
6.1 The hatching generator SHALL be a pure function (DecodedImage + options →
    Polyline[]) with no DOM/WASM/network dependency.
6.2 Tests SHALL assert: per-x tone dependence (a dark patch produces more line
    deviation than a light patch in the same row), non-degenerate bounding box
    (Req 4.1), determinism (Req 3.4), monotonic cost vs. detail (Req 3.1), and
    light-region straightness (Req 2.1).

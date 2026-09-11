# Implementation Plan: Image → Path via Local Python CV Sidecar

## Overview

Move image→path generation out of the browser into a **local Python FastAPI
sidecar** (`tools/imagepath_service/`) running real `cv2` + `scikit-image`.
Primary extraction is **skeleton/centerline** (one clean stroke per region) plus
the silhouette from contours, simplified with `approxPolyDP`. The web SPA POSTs
the image to the service and maps the returned JSON polylines into the
**existing, unchanged** `fitPolylinesToEnvelope` → `PathPlanner.plan` →
`totalStepCount` pipeline. Browser-native modes stay as a fallback when the
service isn't running. No firmware / wire change.

**Why the pivot.** opencv.js (WASM) never loaded reliably in the browser; the
pure-JS Sobel/skeleton fallbacks produced noisy, fragmented gradient-edge lines
at 34k–55k steps. The reference uses real OpenCV in Python (threshold →
skeletonize → contours → approxPolyDP) for clean single strokes at ~2k steps.
This uses the same tool, on the machine where it actually runs.

## Tasks

- [x] 1. Scaffold the Python sidecar (deps, app skeleton, /health)
  - Create `tools/imagepath_service/` with `requirements.txt`
    (opencv-python-headless, numpy, scikit-image, scipy, fastapi,
    uvicorn[standard], pillow, python-multipart), `app.py` (FastAPI app with
    CORS for `http://localhost:5173`, loopback bind), and `run.sh`
    (`uvicorn app:app --host 127.0.0.1 --port 8765 --reload`).
  - Implement `GET /health` → `{ status, version, cv2 }`.
  - Add a `tests/` dir with a smoke test asserting `/health` works and `cv2`
    imports.
  - _Requirements: 5.3_

- [x] 2. Implement the `vectorize` pipeline (skeleton-primary, pure)
  - In `tools/imagepath_service/vectorize.py` implement pure
    `vectorize(image_bytes, params) -> dict` with NO FastAPI types:
    decode (pillow/cv2) → downscale to `max_dim` → grayscale → optional
    contrast/blur → posterize into `tone_bands` (Otsu when `threshold==0`,
    else explicit) → `skimage.morphology.skeletonize` per dark region →
    `walk_skeleton_graph` into ordered pixel chains → `cv2.approxPolyDP`
    smoothing → drop fragments below `min_stroke_len` → add silhouette via
    `cv2.findContours(RETR_EXTERNAL)` → `order_nearest_neighbor` → return
    `{ width, height, polylines }` in pixel space.
  - Define `VectorizeParams` dataclass with documented defaults (mode, detail,
    contrast, threshold, tone_bands, blur_sigma, max_dim, min_stroke_len).
  - Guard `min(width,height) >= 2`; blank/flat input → `polylines: []`.
  - _Requirements: 1.1, 1.3, 2.2, 3.3, 3.4, 4.1_

- [x] 3. Wire `POST /vectorize` and add pytest coverage
  - Add `POST /vectorize` to `app.py` accepting multipart file (and/or
    base64 JSON) + params, delegating to `vectorize.vectorize`, returning the
    `VectorizeResponse` JSON; `400` on undecodable image.
  - In `tools/imagepath_service/tests/test_vectorize.py` (pytest) test on tiny
    synthetic fixtures: skeleton of a known plus/L shape is a single centerline
    (Property 4); determinism (Property 2); bounded output + lowering detail
    doesn't increase vertex count (Property 5); non-degenerate bbox
    (Property 3); JSON schema with coords in `[0,w)×[0,h)` (Property 1); blank
    image → `[]`.
  - Run `python -m pytest tools/imagepath_service/tests` — all green.
  - _Requirements: 4.2, 1.3, 2.2, 3.3, 3.4, 4.1, 6.1, 6.2_

- [x] 4. Add the web client `cv_service_client.ts`
  - Create `web/src/image/cv_service_client.ts`: `DEFAULT_CV_SERVICE_URL`
    (`http://localhost:8765`), `VectorizeParams`, `CvServiceUnavailable`,
    `vectorizeViaService(image, params, {baseUrl, fetchImpl})` (POST
    `/vectorize`, map `number[][][]` → `Polyline[]`), and `isServiceAvailable`
    (probe `/health`). Throw `CvServiceUnavailable` on fetch rejection, non-2xx,
    or schema mismatch. Injectable `fetchImpl`.
  - Add `web/src/image/cv_service_client.test.ts` (vitest, mocked fetch):
    mapping fidelity preserves all coords (Property 6); fetch
    rejection / non-2xx / malformed body each throw `CvServiceUnavailable`
    (Property 7); `isServiceAvailable` returns false when down; a cost check
    feeding mapped polylines through `PathPlanner.plan` (real `totalStepCount`).
  - _Requirements: 5.1, 5.4, 3.1, 6.1, 6.2_

- [x] 5. Wire the CV-service mode into ImagePanel with fallback
  - Add a CV-service style/mode to `web/src/ui/ImagePanel.tsx`; when selected,
    call `vectorizeViaService` and feed results to the existing planner path.
  - On `CvServiceUnavailable`, show a clear banner ("Image service not running —
    start `tools/imagepath_service/run.sh`, then retry. Falling back to browser
    tracing.") and reprocess via the existing browser generator so the app still
    works.
  - Resolve `cvServiceUrl` (default `http://localhost:8765`, `?cv=` override) in
    the spirit of `resolveControllerUrl` in `web/src/app/config.ts`.
  - Run `npx tsc --noEmit` (clean) and `npx vitest --run` (all green); confirm
    edge/centerline/SVG modes unaffected.
  - _Requirements: 5.1, 5.2, 5.3, 6.2_

- [ ] 6. (OPTIONAL — manual, cannot be agent-verified) Hardware visual check
  - Start the Python service, reload `localhost:5173`, import the Tesla photo in
    CV-service mode; confirm clean smooth single strokes (skeleton centerlines +
    silhouette), a recognizable portrait, a much lower "Total length" step count
    than the browser modes, and that the detail/contrast controls move the step
    count predictably. Tune service params (`tone_bands`, `threshold`,
    `epsilon`/`detail`, `min_stroke_len`) as needed.
  - _Requirements: 1.3, 2.2, 3.1, 3.2, 4.1, 4.2_

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2"] },
    { "id": 2, "tasks": ["3"] },
    { "id": 3, "tasks": ["4"] },
    { "id": 4, "tasks": ["5"] }
  ]
}
```

## Notes

- The sidecar is a DEV/DESKTOP tool — it runs on the user's computer, never on
  the ESP32. The firmware single-file build cannot include Python. Browser modes
  remain as fallback. No firmware/wire change.
- The Python service returns raw pixel-space polylines; the EXISTING TS pipeline
  (`fitPolylinesToEnvelope`, `PathPlanner`, `totalStepCount`) fits/plans/costs
  them — do NOT duplicate the planner in Python.
- Machine cost metric is Chebyshev travel (`Σ max(|Δx|,|Δy|)`), not vertex
  count — cost checks use it.
- Service binds to 127.0.0.1 (loopback) and is unauthenticated — acceptable for
  a single-user local tool only.
- Task 6 is OPTIONAL and CANNOT be agent-completed (manual visual judgment on
  the machine); it is excluded from the dependency graph.

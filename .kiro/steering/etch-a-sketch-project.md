# Etch-a-Sketch Machine — Project Guide

Always-on project facts so work here is fast and correct. Three parts:
firmware (ESP32, C++), a browser SPA (`web/`), and a Python image service
(`tools/imagepath_service/`).

## Web SPA (`web/`)

- Stack: **Preact + @preact/signals + Vite**, TypeScript strict. Built to a
  **single self-contained `index.html`** via `vite-plugin-singlefile`.
- Commands (run from `web/`):
  - Dev server: `npm run dev` (serves on `http://localhost:5173`, host `0.0.0.0`).
  - Test: `npx vitest run` (or scope: `npx vitest run src/ui`). Uses jsdom.
  - Typecheck/lint: `npm run lint` (`tsc --noEmit`).
  - Build: `npm run build`.
- **Hard bundle budget: index.html.gz must stay ≤ 120 KB gzipped** — the build
  fails if exceeded (it's embedded in firmware). Currently ~68 KB. Optimize
  assets (WebP, inline via `?inline`) before adding images; check the build's
  reported gzip size after any asset change.
- UI: dark-first design tokens live at the top of `web/src/ui/styles.css`.
  The digital twin is wrapped in a photoreal Etch-a-Sketch frame; the screen
  window insets are CSS variables in `web/src/ui/App.tsx` (`EAS_SCREEN_STYLE`) —
  tweak there to realign the twin, not in the component.
- Text/font rendering: single-line stroke fonts derived from
  `web/src/text/fonts/base_ascii.ts`; `Outline`/`Outline Bold` are double-line
  transforms in `fonts.ts`.

## Known, out-of-scope issue (do NOT "fix" unless asked)

- `web/src/_planner_probe.test.ts` is a developer scratch file that references a
  non-existent `edgeReturnHome` PlanOptions field (should be `edgeReturn`) and
  reads `/tmp`. It fails typecheck/tests and is **pre-existing and unrelated** to
  feature work. Report it if relevant, but leave it untouched.

## Python image service (`tools/imagepath_service/`)

- Use **`python3.13`** — it has the deps (cv2/numpy/PIL/scipy). The base
  `python`/`python3` (anaconda) may lack cv2/fastapi.
- Tests: `python3.13 -m pytest tools/imagepath_service/`.

## Testing conventions

- Property-based testing is used heavily (fast-check in web, hypothesis-style in
  Python). Web PBT: **≥100 iterations**, each property tagged with a
  `// Feature: <name>, Property N: ...` comment. Prefer adding a
  failing-then-passing regression test for every bug fix.

## Verification expectation

After changes: run the relevant tests + `npm run lint` (web) and report results.
The only acceptable lingering failures are the documented out-of-scope items
above.

# web/

Browser SPA for the Etch-a-Sketch Drawing Machine. Built with Preact + TypeScript + Vite. Tests use Vitest + fast-check; e2e flows use Playwright.

## Commands

```bash
npm ci
npm run dev        # Vite dev server on :5173
npm run build      # Production build → dist/, gzipped → dist.gz/, 120 KB budget enforced
npm test           # Vitest + fast-check (unit + property-based)
npm run e2e        # Playwright (requires browsers installed: npx playwright install)
npm run lint       # tsc --noEmit
```

## Layout

- `src/codec/` – Drawing_Command codec, CRC-16/CCITT
- `src/path/` – Path_Planner (RDP, NN-stitch, connectors, scale, ramp)
- `src/gcode/` – G-code emit/parse
- `src/image/` – Image_Processor (Canny via lazy-loaded opencv.js)
- `src/text/` – Text_Renderer + stroke fonts
- `src/freehand/` – Freehand_Capture (Chaikin smoothing)
- `src/net/` – WireClient (binary WebSocket)
- `src/ui/` – Preact components, canvas, wizards
- `tests/unit/` – Vitest unit + property tests (most tests are co-located beside source as `*.test.ts`)
- `tests/e2e/` – Playwright e2e

## Build invariants (Design §10.2)

- Single-file `index.html` output.
- All assets ≤ 8 KB are inlined.
- `dist.gz/index.html.gz` is the firmware-embedded blob.
- Hard size budget: 120 KB gzipped. Build fails if exceeded.

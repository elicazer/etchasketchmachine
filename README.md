# Etch-a-Sketch Drawing Machine

A self-drawing Etch-a-Sketch: an ESP32 firmware drives two stepper motors on the
knobs of a real Etch-a-Sketch, and a browser app turns images, text, and freehand
strokes into single-continuous-line tool paths the machine can draw. Because an
Etch-a-Sketch stylus never lifts, everything is planned as one connected path with
hidden connector routing between strokes.

> Status: hobby / maker project, published as-is. No warranty — see `LICENSE`.

## Architecture

Three independent parts:

| Part | Path | Stack |
|------|------|-------|
| **Firmware** | `firmware/` | ESP32 (Arduino R4 WiFi), C++ / PlatformIO |
| **Web app** | `web/` | Preact + Signals + TypeScript + Vite (builds to a single `index.html`) |
| **Image service** | `tools/imagepath_service/` | Python 3.13 + OpenCV + FastAPI (optional local path-planning sidecar) |

The web app is built to a single self-contained `index.html`, gzipped, and
**embedded directly into the firmware** so the ESP32 serves its own UI over
WiFi — no external hosting required. Commands travel over a binary WebSocket
(with a BLE transport option) to a motion planner running on the device.

### How it fits together

```
image / text / freehand  ─▶  path planner (RDP simplify, NN stitch,
                              hidden connector routing, ramp)
                          ─▶  Drawing_Command codec (+ CRC-16/CCITT)
                          ─▶  WebSocket / BLE  ─▶  ESP32 motion planner
                          ─▶  stepper motors  ─▶  Etch-a-Sketch knobs
```

## Firmware (`firmware/`)

ESP32 firmware built with PlatformIO. Handles WiFi/AP setup, the HTTP + WebSocket
server (serving the embedded web UI), the BLE transport, NVM-persisted config,
backlash compensation, and the on-device motion planner. WiFi credentials are
entered by the user at runtime through the setup page and stored in NVM — none
are baked into the source.

```bash
cd firmware
pio run                 # build
pio test -e host_test   # host-side unit + property tests (no board needed)
```

Extensive host-side tests live in `firmware/tests/` (unit + property-based,
using Catch2 / rapidcheck-style checks) covering the motion planner, Bresenham
stepping, ramp profiles, backlash, the frame codec, CRC-16, ring buffers, NVM,
and the WiFi/HTTP/BLE flows.

## Web app (`web/`)

Browser SPA built with Preact + `@preact/signals` + Vite, TypeScript strict mode.

```bash
cd web
npm ci
npm run dev        # Vite dev server on :5173
npm run build      # production build → dist/, gzipped → dist.gz/ (embedded in firmware)
npm test           # Vitest + fast-check (unit + property-based)
npm run e2e        # Playwright (run `npx playwright install` first)
npm run lint       # tsc --noEmit
```

**Build invariant:** the gzipped single-file bundle must stay ≤ 120 KB (it is
embedded in firmware); the build fails if the budget is exceeded.

Layout:

- `src/codec/` — Drawing_Command codec, CRC-16/CCITT
- `src/path/` — path planner: RDP simplify, nearest-neighbor stitch, connector routing, scale, ramp, machine simulation
- `src/gcode/` — G-code emit/parse
- `src/image/` — image processing (edge/centerline/shaded tracing; OpenCV.js + optional Python CV service)
- `src/text/` — text renderer + single-line stroke fonts
- `src/freehand/` — freehand capture with Chaikin smoothing
- `src/composer/` — unified composer canvas
- `src/net/` — binary WebSocket / BLE wire client
- `src/ui/` — Preact components, the photoreal digital-twin canvas, and setup wizards

## Image service (`tools/imagepath_service/`)

Optional local FastAPI service that performs heavier image-to-path vectorization
in Python (OpenCV, NumPy, SciPy). Runs loopback-only and is intended as a
single-user local dev tool — it is not hardened for exposure to a network.

```bash
cd tools/imagepath_service
python3.13 -m pip install -r requirements.txt
python3.13 -m pytest          # tests
./run.sh                      # start the service (loopback)
```

## Building the full device

1. Build the web app (`cd web && npm ci && npm run build`) — produces
   `web/dist.gz/index.html.gz`.
2. Embed it into firmware (`firmware/scripts/embed_web_assets.py` regenerates
   `firmware/src/web_assets.h`).
3. Flash the firmware to the ESP32 (`cd firmware && pio run -t upload`).
4. On first boot the device starts a setup access point; connect and enter your
   WiFi credentials through the page it serves.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE).

Copyright 2026 Eli Azer.

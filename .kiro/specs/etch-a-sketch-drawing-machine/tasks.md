# Implementation Plan: Etch-a-Sketch Drawing Machine

## Overview

This plan implements a two-axis CNC Etch-a-Sketch plotter driven by an Arduino R4 WiFi with a browser-based SPA for image import, text rendering, freehand drawing, and path planning. The firmware (C++ / PlatformIO) handles WiFi, WebSocket, motion control, and NVM persistence. The web app (TypeScript / Preact / Vite) handles all path pipeline logic and UI. Tasks are ordered so dependencies are satisfied: scaffolding → shared utilities → firmware foundation → motion stack → web path pipeline → web UI → integration → polish.

## Tasks

- [x] 1. Project scaffolding and shared utilities
  - [x] 1.1 Initialize web project with Vite, Preact, TypeScript, Vitest, and fast-check
    - Create `web/` directory with `package.json`, `vite.config.ts`, `tsconfig.json`
    - Configure Vite for Preact with JSX, single-file output, gzip, 120 KB budget
    - Add Vitest and fast-check as dev dependencies
    - Add Playwright for e2e tests
    - _Requirements: Design §10.2_
  - [x] 1.2 Initialize firmware project with PlatformIO and directory structure
    - Create `firmware/` with `platformio.ini`, `etchasketch.ino`, and `src/` subdirectories
    - Configure `[env:uno_r4_wifi]` for Renesas RA platform with Arduino framework
    - Configure `[env:host_test]` for native platform with Catch2 and rapidcheck
    - Create `firmware/tests/` directory
    - _Requirements: Design §10.3_
  - [x] 1.3 Implement CRC-16/CCITT shared utility (web)
    - Implement `crc16ccitt(data: Uint8Array): number` in `web/src/codec/crc16.ts`
    - Poly 0x1021, init 0xFFFF, no final XOR
    - _Requirements: 7.2, Design §4.3_
  - [x] 1.4 Implement CRC-16/CCITT shared utility (firmware)
    - Implement `uint16_t crc16_ccitt(const uint8_t* data, size_t len)` in `firmware/src/protocol/crc16.cpp`
    - Same algorithm as web: poly 0x1021, init 0xFFFF, no final XOR
    - _Requirements: 7.2, Design §4.3_
  - [x] 1.5 Define shared constants and data types (web)
    - Create `web/src/types.ts` with `Point`, `Polyline`, `SegmentKind`, `PlannedSegment`, `PlannedPath`, `DrawingCommand`, `GCodeLine`, `GCodeProgram`
    - Define constants: drawable area (152×105 mm), gear math (400 steps/knob rev), speed limits (100–1000 sps)
    - _Requirements: 5.2, 5.3, 6.3, Design §4.1–4.3_
  - [x] 1.6 Define shared constants and data types (firmware)
    - Create `firmware/src/types.h` with `DrawingCommand`, `Position`, `BacklashConfig`, `PersistedConfig` structs
    - Define constants: buffer size (32), speed limits, gear math, NVM layout offsets
    - _Requirements: 6.3, 6.4, Design §4.3–4.4_

- [x] 2. Firmware NVM and persistence layer
  - [x] 2.1 Implement PersistedConfig NVM codec with CRC-32 validation
    - Implement `NVMManager` class in `firmware/src/nvm/nvm_manager.cpp`
    - Read/write 132-byte packed record at EEPROM offset 0
    - Validate magic (0x45534B31), version, and trailing CRC-32
    - Return documented defaults on bad magic or CRC mismatch
    - Implement debounced writes (250 ms minimum interval)
    - Implement `wasUncleanShutdown()`, `markCleanIdle()`, `markBusy()`
    - _Requirements: 1.5, 10.5, 10.6, 10.12, 13.5, Design §4.4, §3.2.7_
  - [x] 2.2 Write property tests for NVM round-trip and corruption defaults (firmware)
    - **Property 13: NVM round-trip and corruption defaults**
    - **Validates: Requirements 1.5, 13.5, 13.10**
  - [x] 2.3 Write property test for NVM position consistency at quiescent points (firmware)
    - **Property 14: NVM position consistency at idle**
    - **Validates: Requirements 10.6**
  - [x] 2.4 Write property test for unclean shutdown behavior (firmware)
    - **Property 15: Unclean shutdown clears calibration and retains hint**
    - **Validates: Requirements 10.12**

- [x] 3. Firmware WiFi, HTTP, and WebSocket server
  - [x] 3.1 Implement WiFiManager with STA/AP fallback and mDNS
    - Create `firmware/src/wifi/wifi_manager.cpp`
    - STA connection attempt within 10 s of boot, 30 s timeout before AP fallback
    - AP mode with SSID `EtchSketch_<MAC4>`
    - mDNS registration as `etchasketch.local`
    - Credential validation (SSID 1–32 chars, password 8–63 chars)
    - Save credentials to NVM and restart connection
    - Reconnect logic: 30 s retry then AP fallback on link loss
    - RSSI reporting
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 12.2_
  - [x] 3.2 Implement HTTP server for SPA hosting and REST endpoints
    - Serve gzipped SPA from PROGMEM on GET `/`
    - Implement GET `/api/info` (firmware version, IP, RSSI, hostname, calibration state)
    - Implement POST `/api/wifi` for credential submission in AP mode
    - _Requirements: 1.2, 1.4, Design §3.2.2_
  - [x] 3.3 Implement WebSocket server with binary frame protocol
    - Create `firmware/src/protocol/ws_server.cpp`
    - Single-client enforcement (reject additional with `session-busy`)
    - Binary frame envelope: version (0x01), type, length, payload
    - Implement frame dispatch by type code (CMD, CTL, ACK, NACK, etc.)
    - _Requirements: 7.1, Design §4.5_

- [x] 4. Firmware command parsing and protocol layer
  - [x] 4.1 Implement CommandParser with CRC validation and range checking
    - Create `firmware/src/protocol/command_parser.cpp`
    - Parse 16-byte Drawing_Command payload from binary frame
    - Recompute CRC-16/CCITT and compare with transmitted CRC
    - Range-check: `feed_sps ∈ [100, 1000]`, `|dx|, |dy| ≤ 32767`, `flags & ~0b11 == 0`, `reserved == 0`
    - Emit NACK (PARSE or RANGE) or RETX_REQUEST (CRC error)
    - _Requirements: 6.7, 7.3, Design §3.2.4_
  - [x] 4.2 Implement retransmission logic and sequence tracking
    - Track per-sequence retransmission count (max 3)
    - Emit UNRECOVERABLE_TX error after 3rd failed retransmission
    - Handle duplicate seq with idempotent ACK
    - Pause drawing on unrecoverable error
    - _Requirements: 7.3, 7.7_
  - [x] 4.3 Implement flow control with credit-based protocol
    - Send initial CREDIT {n:32} on BEGIN_DRAW
    - Emit CREDIT {n:1} on each consumed buffer slot
    - Withhold credits at high-water (28), resume at low-water (16)
    - _Requirements: 6.4, 6.5, Design §6.4_
  - [x] 4.4 Implement Control message (CTL) parser
    - Parse all CTL kinds: PAUSE, RESUME, CANCEL, STOP, JOG, SET_HOME, RE_HOME, BEGIN_DRAW, END_DRAW, SPEED_PCT, SET_BACKLASH, MOTOR_TEST, FAULT_RESET
    - Validate per-kind payloads (e.g., SPEED_PCT 25–100, SET_BACKLASH 0–200)
    - _Requirements: 9.1–9.8, 10.3–10.5, 10.13, 12.4, 12.6, 13.8, Design §4.6_
  - [x] 4.5 Write property tests for command parser rejection (firmware)
    - **Property 8: Command parser rejects out-of-range fields without enqueuing**
    - **Validates: Requirements 6.7**
  - [x] 4.6 Write property tests for reliable delivery with bounded retransmission (firmware)
    - **Property 9: Reliable delivery with bounded retransmission**
    - **Validates: Requirements 7.3, 7.7**

- [x] 5. Checkpoint - Ensure all firmware foundation tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Firmware motion stack
  - [x] 6.1 Implement Bresenham line algorithm for coordinated two-axis stepping
    - Create `firmware/src/motion/bresenham.cpp`
    - Generate step sequence for (dx, dy) with exactly |dx| X-steps and |dy| Y-steps
    - Maintain perpendicular error ≤ 1 step from ideal line
    - Output step/direction pairs for ISR consumption
    - _Requirements: 6.1, Design §2.4.2_
  - [x] 6.2 Write property test for Bresenham line-error bound (firmware)
    - **Property 6: Bresenham line-error bound**
    - **Validates: Requirements 6.1**
  - [x] 6.3 Implement trapezoidal speed ramp generator
    - Create `firmware/src/motion/ramp.cpp`
    - Generate unimodal speed schedule: accel from v_min (100 sps) to v_peak, decel back to v_min
    - Support live speed-percent scaling (25–100%)
    - Ensure consecutive speeds differ by at most configured acceleration step
    - Handle short segments where peak speed is never reached (triangular profile)
    - _Requirements: 5.5, 6.3, 9.7, 9.8, Design §2.4.2_
  - [x] 6.4 Write property test for trapezoidal speed schedule (firmware)
    - **Property 5: Trapezoidal speed schedule monotonicity and bounds**
    - **Validates: Requirements 5.5, 6.3, 9.7, 9.8**
  - [x] 6.5 Implement 32-deep SPSC ring buffer for command queuing
    - Create `firmware/src/motion/ring_buffer.cpp`
    - Fixed 32-slot capacity, FIFO ordering
    - Push returns false when full
    - Thread-safe for single-producer (main loop) / single-consumer (ISR)
    - _Requirements: 6.4, 6.5_
  - [x] 6.6 Write property test for ring buffer bounded FIFO (firmware)
    - **Property 7: Command buffer is a bounded FIFO with flow control**
    - **Validates: Requirements 6.4, 6.5**
  - [x] 6.7 Implement BacklashCompensator
    - Create `firmware/src/backlash/backlash_compensator.cpp`
    - Track last direction per axis; on reversal, prepend compensation steps
    - Compensation steps NOT counted toward logical position
    - Load/save backlash values from/to NVM
    - `onHome()` resets last-direction state
    - Default backlash = 0 when no stored value
    - _Requirements: 13.4, 13.5, 13.6, 13.7, 13.10, Design §3.2.6_
  - [x] 6.8 Write property test for backlash compensation preserving logical position (firmware)
    - **Property 10: Backlash compensation preserves logical position**
    - **Validates: Requirements 13.4, 13.6, 13.7, 13.10**
  - [x] 6.9 Implement MotionPlanner with GPT timer ISR integration
    - Create `firmware/src/motion/motion_planner.cpp`
    - Pull commands from ring buffer, apply backlash, compute ramp, run Bresenham
    - Configure FspTimer (GPT) for per-tick ISR that pulses STEP pins
    - Multiply full steps by 16 for microstep output
    - Track logical position (counted steps only)
    - Persist position to NVM (debounced)
    - Implement pause (stop within 50 ms), resume, cancel (clear buffer within 100 ms), stop (decel within 50 ms)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 9.2, 9.4, 9.5, Design §3.2.5_
  - [x] 6.10 Write property test for pause/resume position fidelity (firmware)
    - **Property 18: Pause/resume position fidelity**
    - **Validates: Requirements 9.4**
  - [x] 6.11 Write property test for single full-step jog (firmware)
    - **Property 16: Single full-step jog**
    - **Validates: Requirements 10.3**

- [x] 7. Firmware diagnostics and status reporting
  - [x] 7.1 Implement fault and stall detection
    - Create `firmware/src/diagnostics/diagnostics.cpp`
    - Poll A3 (fault input) every loop iteration; on LOW, disable EN within 10 ms
    - Stall detection: missed-deadline counter ≥ 4 in a single segment raises stall
    - Emit ERROR frames (STALL or FAULT) with axis identification
    - Implement fault reset (re-enable EN, clear latch)
    - _Requirements: 12.3, 12.5, 12.6, Design §3.2.8_
  - [x] 7.2 Write property test for stall-detector threshold (firmware)
    - **Property 19: Stall-detector threshold**
    - **Validates: Requirements 12.3**
  - [x] 7.3 Implement StatusReporter
    - Create `firmware/src/diagnostics/status_reporter.cpp`
    - Aggregate position, percent complete, RSSI, fault/stall flags, state
    - Emit STATUS frame ≥ 1 Hz during drawing, ≥ 0.2 Hz idle
    - _Requirements: 7.4, 10.9, 12.2, Design §3.2.9, §4.7_
  - [x] 7.4 Implement motor test routine
    - Move each motor 200 steps forward and 200 steps backward
    - Report per-axis pass/fail (stall or fault = fail)
    - _Requirements: 12.4_
  - [x] 7.5 Implement idle timeout and EN disable
    - After 5 s idle, drive EN HIGH to disable holding torque
    - Re-enable on next motion command
    - _Requirements: 6.8, Design §9.3_

- [x] 8. Firmware main loop integration and HELLO frame
  - [x] 8.1 Wire all firmware modules into main cooperative loop
    - `etchasketch.ino`: setup() initializes NVM, WiFi, HTTP, WS, MotionPlanner, Diagnostics
    - loop() calls: WiFiManager.supervise(), WSServer.serviceLoop(), MotionPlanner.serviceLoop(), Diagnostics.poll(), StatusReporter.tick(), NVM.flushIfDue()
    - Implement HELLO frame on WebSocket connect (firmware version, calibration state, backlash, position)
    - Implement connection-loss handling: pause on WS disconnect, 60 s reconnect window, abort on timeout
    - _Requirements: 7.5, 7.6, 10.2, Design §4.8, §5.6_
  - [x] 8.2 Implement auto-return to home after drawing completion
    - On last command consumed, synthesize connector segment from current position to (0,0)
    - Execute return motion, then mark NVM clean idle
    - _Requirements: 10.7, 14.7_

- [x] 9. Checkpoint - Ensure all firmware tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Web Drawing_Command codec and wire protocol
  - [x] 10.1 Implement Drawing_Command binary encoder/decoder
    - Create `web/src/codec/drawing_command.ts`
    - Encode/decode 16-byte little-endian payload per §4.3
    - Attach CRC-16/CCITT over bytes [0..14)
    - Split large motions exceeding i16 range into multiple commands
    - _Requirements: 7.2, 7.8, Design §4.3_
  - [x] 10.2 Write property test for Drawing_Command serialization round-trip (web)
    - **Property 1: Drawing_Command serialization round-trip**
    - **Validates: Requirements 7.2, 7.8**
  - [x] 10.3 Implement WebSocket frame envelope encoder/decoder
    - Create `web/src/codec/frame.ts`
    - Encode/decode 4-byte envelope header (version, type, length) + typed payload
    - Support all frame types: CMD, CTL, ACK, NACK, RETX_REQUEST, STATUS, CREDIT, HELLO, STATE, ERROR, PROGRESS
    - _Requirements: 7.1, Design §4.5_
  - [x] 10.4 Implement WireClient with retransmission and flow control
    - Create `web/src/net/wire_client.ts`
    - WebSocket binary connection to `/ws`
    - Sequence number management, CRC attachment
    - Retransmission on RETX_REQUEST (max 3 attempts)
    - Credit-based flow control (wait for CREDIT before sending)
    - 60-second reconnect window on disconnect
    - Event emitter for state, progress, fault, stall, rssi, flow, home
    - Send-gate: block CMD/BEGIN_DRAW when calibrated flag is false
    - _Requirements: 7.1, 7.3, 7.5, 7.6, 7.7, 10.11, Design §3.1.5_
  - [x] 10.5 Write property test for send-gate on calibration (web)
    - **Property 17: Send-gate on calibration**
    - **Validates: Requirements 10.11**

- [x] 11. Web path pipeline - RDP simplification
  - [x] 11.1 Implement Ramer-Douglas-Peucker line simplification
    - Create `web/src/path/rdp.ts`
    - Accept polyline and tolerance ε ∈ [0.1, 5.0] steps
    - Preserve first and last points
    - Guarantee max distance from original ≤ ε
    - _Requirements: 5.4, Design §3.1.4_
  - [x] 11.2 Write property test for RDP simplification (web)
    - **Property 4: RDP simplification distance bound and idempotence**
    - **Validates: Requirements 5.4**

- [x] 12. Web path pipeline - Nearest-neighbor stitching and connectors
  - [x] 12.1 Implement nearest-neighbor polyline ordering with endpoint flipping
    - Create `web/src/path/stitch.ts`
    - Order polylines to minimize total connector length
    - Allow flipping polyline direction for shorter connections
    - Insert straight-line connector segments between successive polylines
    - _Requirements: 4.7, 14.1, 14.2, 14.3, Design §3.1.4_
  - [x] 12.2 Implement auto-return connector to home (0,0)
    - Append final connector segment from last point to (0,0)
    - Tag as `kind: 'connector'`
    - _Requirements: 10.7, 14.7_
  - [x] 12.3 Write property test for continuous-stroke construction (web)
    - **Property 11: Continuous-stroke construction**
    - **Validates: Requirements 4.7, 11.7, 14.1, 14.2, 14.3**
  - [x] 12.4 Write property test for auto-return ends at home (web)
    - **Property 12: Auto-return ends at home**
    - **Validates: Requirements 10.7, 14.7**

- [x] 13. Web path pipeline - Scale, clamp, and step conversion
  - [x] 13.1 Implement coordinate scaling, clamping, and step conversion
    - Create `web/src/path/scale.ts`
    - Convert canvas-space polylines to mm in 152×105 drawable area
    - Clamp out-of-bounds points to boundary
    - Convert mm to integer full motor steps using `400 / mm_per_rev_axis`
    - Apply home offset
    - _Requirements: 5.2, 5.3, 10.10, Design §3.1.4_
  - [x] 13.2 Write property test for planner clamp, scale, and offset (web)
    - **Property 3: Planner clamp, scale, and home-relative offset**
    - **Validates: Requirements 5.2, 5.3, 10.10**

- [x] 14. Web path pipeline - G-Code generation and parsing
  - [x] 14.1 Implement G-Code emitter and parser
    - Create `web/src/gcode/gcode.ts`
    - Emit `G1 X<steps> Y<steps> F<sps>` lines with M3/M5 connector markers
    - Parse G-Code back to PlannedPath
    - Round-trip within 1 step tolerance
    - _Requirements: 5.1, 5.6, 14.6, Design §4.2_
  - [x] 14.2 Write property test for G-Code program round-trip (web)
    - **Property 2: G-Code program round-trip**
    - **Validates: Requirements 5.1, 5.6, 14.6**

- [x] 15. Web path pipeline - Path_Planner orchestrator
  - [x] 15.1 Implement Path_Planner.plan() orchestrating the full pipeline
    - Create `web/src/path/planner.ts`
    - Pipeline: scale/clamp → step conversion → RDP simplify → NN stitch → auto-return
    - Implement `toCommands()`: convert PlannedPath to DrawingCommand array with sequence numbers
    - Implement `estimateMillis()`: total steps / feed_sps
    - _Requirements: 5.1–5.5, 10.7, 14.1–14.3, 14.5–14.7, Design §3.1.4_
  - [x] 15.2 Write property test for estimated drawing time formula (web)
    - **Property 26: Estimated drawing time formula**
    - **Validates: Requirements 8.2, 8.3, 14.4, 14.5**

- [x] 16. Checkpoint - Ensure all path pipeline tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Web Image_Processor module
  - [x] 17.1 Implement image loading and raster edge detection
    - Create `web/src/image/image_processor.ts`
    - Load PNG/JPEG/BMP via canvas decode; validate format and 10 MB limit
    - Lazy-load opencv.js WASM for Canny edge detection
    - Implement Gaussian blur → Sobel → non-maximum suppression → double-threshold hysteresis
    - Adjustable lower/upper thresholds (0–255)
    - Convert edges to ordered polylines with pixel-adjacency (Chebyshev ≤ 1)
    - Handle empty contour set with NoEdgesFound error
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 4.1, 4.2, 4.3, 4.6, 4.8, Design §3.1.1_
  - [x] 17.2 Implement SVG path extraction
    - Parse SVG DOM, extract supported elements (path, line, polyline, polygon, rect, circle, ellipse)
    - Tessellate curves with chord error ≤ 0.5 px
    - Skip unsupported elements (text, filters, gradients) with notification
    - _Requirements: 4.4, 4.5_
  - [x] 17.3 Implement nearest-neighbor contour ordering in Image_Processor
    - Order detected polylines using NN heuristic to minimize connector length
    - _Requirements: 4.7_
  - [x] 17.4 Write property test for polyline pixel-adjacency (web)
    - **Property 20: Polyline pixel-adjacency**
    - **Validates: Requirements 4.6**
  - [x] 17.5 Write property test for NMS single-pixel-width (web)
    - **Property 21: Non-maximum suppression yields single-pixel-width contours**
    - **Validates: Requirements 4.3**
  - [x] 17.6 Write property test for SVG path round-trip (web)
    - **Property 22: SVG path round-trip**
    - **Validates: Requirements 4.4, 4.5**

- [x] 18. Web Text_Renderer module
  - [x] 18.1 Implement stroke font loading and text rendering
    - Create `web/src/text/text_renderer.ts`
    - Bundle ≥ 5 Hershey-derived single-line stroke fonts as JSON glyph dictionaries
    - Shape text into positioned glyph polylines
    - Support font size 5–100 mm, letter spacing 0–200%
    - Detect unsupported codepoints and suggest covering font
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, Design §3.1.2_
  - [x] 18.2 Write property test for unsupported codepoint highlight (web)
    - **Property 28: Unsupported codepoint highlight matches missing set**
    - **Validates: Requirements 3.5**

- [x] 19. Web Freehand_Capture module
  - [x] 19.1 Implement freehand drawing capture with Chaikin smoothing
    - Create `web/src/freehand/freehand_capture.ts`
    - Sample pointer events at ≥ 60 Hz between pointerdown and pointerup
    - Discard strokes with < 3 points
    - Apply 2 iterations of Chaikin's corner-cutting on pointerup
    - Maintain undo stack of ≥ 50 strokes
    - Implement clear function
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, Design §3.1.3_
  - [x] 19.2 Write property test for Chaikin smoothing bounded deviation (web)
    - **Property 23: Chaikin smoothing bounded deviation**
    - **Validates: Requirements 11.1, 11.3, 11.6**
  - [x] 19.3 Write property test for undo and clear semantics (web)
    - **Property 24: Undo and clear semantics**
    - **Validates: Requirements 11.4, 11.5**

- [x] 20. Web input validators
  - [x] 20.1 Implement parameterized input validators
    - Create `web/src/validators.ts`
    - WiFi credentials: SSID 1–32 chars, password 8–63 chars
    - Image upload: format ∈ {png, jpeg, bmp, svg}, size ≤ 10 MB
    - Image transform: scale [0.10, 5.00], rotation [0, 359]
    - Text: reject empty/whitespace-only; font size [5, 100] mm; letter spacing [0, 200]%
    - Speed slider: integer [25, 100]
    - Backlash edit: integer [0, 200]
    - _Requirements: 1.4, 2.1, 2.3, 2.4, 3.3, 3.6, 9.7, 13.8_
  - [x] 20.2 Write property test for input validators (web)
    - **Property 27: Input validators (parameterized)**
    - **Validates: Requirements 1.4, 2.1, 2.3, 2.4, 3.3, 3.6, 6.7, 9.7, 13.8**

- [x] 21. Web out-of-bounds detection
  - [x] 21.1 Implement out-of-bounds segment detection and highlighting
    - Create `web/src/path/bounds.ts`
    - Detect segments with endpoints outside [0, 152] × [0, 105] mm
    - Return set of OOB segments for UI highlighting
    - _Requirements: 8.6_
  - [x] 21.2 Write property test for out-of-bounds detection (web)
    - **Property 25: Out-of-bounds detection**
    - **Validates: Requirements 8.6**

- [x] 22. Web trapezoidal speed schedule (browser-side preview)
  - [x] 22.1 Implement trapezoidal speed schedule for preview timing
    - Create `web/src/path/ramp.ts`
    - Mirror firmware ramp logic for accurate time estimation
    - Support speed-percent scaling for preview playback
    - _Requirements: 5.5, 8.3, Design §3.1.4_
  - [x] 22.2 Write property test for trapezoidal speed schedule (web)
    - **Property 5: Trapezoidal speed schedule monotonicity and bounds (web mirror)**
    - **Validates: Requirements 5.5, 6.3, 9.7, 9.8**

- [x] 23. Checkpoint - Ensure all web module tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 24. Web UI - Core layout and drawing canvas
  - [x] 24.1 Implement main app shell and drawing canvas component
    - Create `web/src/ui/App.tsx` and `web/src/ui/Canvas.tsx`
    - Canvas at 152:105 aspect ratio, ≥ 300 CSS px wide
    - Render planned paths: solid black for strokes, dashed grey for connectors
    - Display estimated drawing time and total path length
    - Highlight out-of-bounds segments in red dashed style with warning
    - _Requirements: 8.1, 8.3, 8.6, 14.4, 14.5_
  - [x] 24.2 Implement animated preview with playback speed control
    - Create `web/src/ui/Preview.tsx`
    - Animate drawing order at 0.25×–4× real-time
    - Visually distinguish connectors from strokes during animation
    - _Requirements: 8.2, 14.4_

- [x] 25. Web UI - Input panels (image, text, freehand)
  - [x] 25.1 Implement image import panel
    - Create `web/src/ui/ImagePanel.tsx`
    - File upload with format/size validation
    - Preview display within canvas
    - Scale (10–500%), rotation (0–359°), position controls
    - Canny threshold sliders (lower/upper 0–255) with ≤ 500 ms preview update
    - Error messages for unsupported format, oversize, corrupt files
    - _Requirements: 2.1–2.7, 4.2_
  - [x] 25.2 Implement text input panel
    - Create `web/src/ui/TextPanel.tsx`
    - Text input (1–200 chars), font selector (≥ 5 fonts), font size, letter spacing
    - Live preview update on parameter change
    - Unsupported character highlighting with font suggestion
    - Disable draw when empty/whitespace
    - _Requirements: 3.1–3.6_
  - [x] 25.3 Implement freehand drawing panel
    - Create `web/src/ui/FreehandPanel.tsx`
    - Drawing tool with pointer event capture
    - Undo (≥ 50 levels) and clear buttons
    - "Send to machine" action
    - _Requirements: 11.1–11.7_

- [x] 26. Web UI - Drawing execution controls
  - [x] 26.1 Implement drawing execution control panel
    - Create `web/src/ui/DrawingControls.tsx`
    - Pause/Resume/Cancel buttons with correct state visibility
    - Speed adjustment slider (25–100% in 1% increments)
    - Progress display (percentage, current position)
    - Connection status indicator (color-coded: connected/disconnected/connecting)
    - _Requirements: 9.1–9.8, 12.1_

- [x] 27. Web UI - Calibration and backlash wizards
  - [x] 27.1 Implement manual jog and homing wizard
    - Create `web/src/ui/CalibrationWizard.tsx`
    - Manual jog controls (single full-step per click, both axes, both directions)
    - "Set Home" button to declare current position as (0,0)
    - Block drawing when uncalibrated
    - Display current position in steps relative to home
    - Re-home control that clears calibrated flag
    - Handle unclean shutdown recovery (show last known position hint)
    - _Requirements: 10.1–10.5, 10.9, 10.11, 10.12, 10.13_
  - [x] 27.2 Implement backlash calibration wizard
    - Create `web/src/ui/BacklashWizard.tsx`
    - Per-axis wizard: forward jog → reverse one step at a time → user confirms motion
    - Record step count as backlash value
    - Manual edit fields (0–200 steps)
    - Display current stored values
    - Warning when backlash is 0 and uncalibrated
    - _Requirements: 13.1–13.5, 13.8, 13.9, 13.11_

- [x] 28. Web UI - Diagnostics panel
  - [x] 28.1 Implement diagnostics and status panel
    - Create `web/src/ui/DiagnosticsPanel.tsx`
    - Connection status with color-coded indicator (update within 2 s)
    - WiFi RSSI display in dBm (update every 5 s)
    - Motor test button with per-axis pass/fail result
    - Fault indicator with reset control
    - Stall notification with axis identification
    - _Requirements: 12.1–12.6_

- [x] 29. Web SPA entry point and build integration
  - [x] 29.1 Implement main entry point and routing
    - Create `web/src/main.ts` wiring App shell, signal stores, and WireClient
    - Configure lazy-loading of opencv.js WASM on first image import
    - Ensure single-file HTML output from Vite build
    - _Requirements: Design §10.2, §2.4.1_
  - [x] 29.2 Implement embed_web_assets build script
    - Create `firmware/scripts/embed_web_assets.py`
    - Read `web/dist/index.html.gz`, verify ≤ 120 KB
    - Emit `firmware/src/web_assets.h` with PROGMEM byte array
    - _Requirements: Design §10.3, §2.4.4_

- [x] 30. Checkpoint - Ensure web build passes size budget and all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Verify `npm run build` produces gzipped output ≤ 120 KB

- [x] 31. Integration - End-to-end wiring and WiFi credential flow
  - [x] 31.1 Wire web WireClient to firmware WebSocket server end-to-end
    - Verify HELLO frame exchange on connect
    - Verify CMD → ACK flow with real CRC validation
    - Verify CTL messages (JOG, SET_HOME, PAUSE, RESUME, CANCEL, SPEED_PCT)
    - Verify STATUS frame reception and UI state updates
    - Verify credit-based flow control under load
    - _Requirements: 7.1, 7.4, Design §5.2_
  - [x] 31.2 Implement WiFi credential submission flow (AP mode)
    - Web UI configuration page in AP mode
    - POST `/api/wifi` with validation
    - Store credentials and restart STA connection
    - Display assigned IP and mDNS hostname on success
    - _Requirements: 1.3, 1.4, 1.5, 1.7_

- [x] 32. Integration - Drawing execution end-to-end
  - [x] 32.1 Implement full drawing execution flow
    - BEGIN_DRAW → stream CMD frames → auto-return → idle
    - Verify position tracking through entire drawing
    - Verify connector segments execute as visible motion
    - Verify NVM persistence of position during and after drawing
    - _Requirements: 6.1–6.5, 7.1–7.4, 10.6, 10.7, 14.6, 14.7, Design §5.2_
  - [x] 32.2 Implement connection loss and recovery flow
    - Pause on WS disconnect, retain position
    - Resume within 60 s reconnect window
    - Abort and report CONN_TIMEOUT after 60 s
    - _Requirements: 7.5, 7.6, Design §5.6_
  - [x] 32.3 Implement drawing control flows (pause/resume/cancel/speed)
    - Pause within 50 ms, resume from exact position
    - Cancel clears buffer within 100 ms
    - Speed adjustment applied at next segment boundary
    - _Requirements: 9.1–9.8_

- [x] 33. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Run `cd web && npm test` (Vitest + fast-check)
  - Run `cd firmware && pio test -e host_test` (Catch2 + rapidcheck)
  - Verify firmware compiles for target: `pio run -e uno_r4_wifi`

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from Design §7
- Unit tests validate specific examples and edge cases
- The firmware and web path pipeline modules are largely independent and can be developed in parallel after scaffolding
- The web SPA must fit within 120 KB gzipped to embed in firmware flash
- opencv.js is lazy-loaded and does not count against the always-resident bundle size
- All firmware host tests use Catch2 + rapidcheck; all web tests use Vitest + fast-check

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.5", "1.6"] },
    { "id": 2, "tasks": ["2.1", "3.1", "10.1", "11.1", "13.1", "14.1", "20.1", "21.1", "22.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3", "10.2", "10.3", "11.2", "12.1", "13.2", "14.2", "17.1", "18.1", "19.1", "20.2", "21.2", "22.2"] },
    { "id": 4, "tasks": ["4.1", "4.2", "4.3", "4.4", "10.4", "10.5", "12.2", "12.3", "12.4", "15.1", "17.2", "17.3", "17.4", "17.5", "18.2", "19.2", "19.3"] },
    { "id": 5, "tasks": ["4.5", "4.6", "6.1", "6.3", "6.5", "6.7", "15.2", "17.6"] },
    { "id": 6, "tasks": ["6.2", "6.4", "6.6", "6.8", "6.9"] },
    { "id": 7, "tasks": ["6.10", "6.11", "7.1", "7.3", "7.4", "7.5"] },
    { "id": 8, "tasks": ["7.2", "8.1", "8.2"] },
    { "id": 9, "tasks": ["24.1", "24.2", "25.1", "25.2", "25.3"] },
    { "id": 10, "tasks": ["26.1", "27.1", "27.2", "28.1"] },
    { "id": 11, "tasks": ["29.1", "29.2"] },
    { "id": 12, "tasks": ["31.1", "31.2"] },
    { "id": 13, "tasks": ["32.1", "32.2", "32.3"] }
  ]
}
```

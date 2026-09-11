# Implementation Plan: BLE Transport Switch

## Overview

This plan makes BLE the default browser↔Controller transport while keeping WiFi as a compile-time-selectable fallback, without changing any wire byte layout. The work is purely additive at the transport seam: extract the shared framing core, add a host-testable MTU chunking/reassembly core on both sides, add the BLE radio plumbing (`BleServer` firmware / `BleSocket` browser), and add build-flag/config-point transport selection.

The bias is to keep as much logic as possible pure and host-testable. The riskiest new code is the MTU chunking/reassembly core (Properties 1, 2), which is implemented once per language as a pure module and is the primary property-based-testing surface. Properties 3–11 cover logic that is reused unchanged from the existing `FrameCodec`/`WireClient`/validator/flow-control code; the plan ensures those existing tests still pass after the refactor rather than rewriting them.

Tasks are ordered so each builds on the previous: firmware framing extraction → firmware chunking core + PBT → firmware BleServer → firmware build selection + wiring → web chunking core + PBT → web BleSocket → web config point + wiring → build verification → regression checkpoint → clearly-marked HIL/manual verification (non-blocking, requires real hardware).

Environment notes for the executor:
- Web: `cd web && npm test` (Vitest + fast-check) and `cd web && npm run build` both work.
- Firmware host tests: `cd firmware && pio test -e host_test` (Catch2 + rapidcheck, custom runner via per-suite `int main`). PlatformIO is installed (`~/Library/Python/3.13/bin/pio`). Each new host suite lives in its own `firmware/tests/test_*/` directory with its own `int main(...) { return Catch::Session().run(...); }`, mirroring the existing suites (e.g. `test_frame`).
- Real BLE behavior (advertising, GATT connect from a browser, throughput, RSSI) CANNOT be verified by the executor. Those are HIL/manual items (section 13), explicitly non-blocking for the codeable/testable tasks.

## Tasks

- [x] 1. Extract the shared framing/dispatch core from `WSServer` (behavior-preserving refactor)
  - [x] 1.1 Create `FrameCodec` shared core
    - Create `firmware/src/protocol/frame_codec.{h,cpp}` with `PARSE_BUFFER_CAPACITY = 256`
    - Move the byte-accumulator verbatim from `WSServer`: `onFrame()`, `feedBytes()`, private `drainFrames()` (version-byte resync, oversize-frame desync, canonical `decodeFrameHeader`), and the parse buffer state
    - Move single-client state verbatim: `isClientConnected()`, `handleNewConnection()`, `closeConnection()`, `buildSessionBusyFrame()`; keep `ingestForTest()` delegating to `feedBytes()`
    - Keep the header Arduino-include-free so it compiles under `platform = native`
    - _Requirements: 13.4_
    - _Design: §3.1, §3.3 (FrameCodec)_
  - [x] 1.2 Refactor `WSServer` to delegate framing to `FrameCodec`
    - Modify `firmware/src/protocol/ws_server.{h,cpp}` to own only RFC6455/radio plumbing and hold a `FrameCodec` member
    - Route inbound unmasked bytes into `codec_.feedBytes(...)`; forward `onFrame()`/`isClientConnected()`/single-client calls to the codec; keep `ingestForTest()` working
    - Preserve the public `WSServer` seam exactly (`begin`/`serviceLoop`/`sendBinary`/`onFrame`/`isClientConnected`) so the sketch is unaffected
    - _Requirements: 13.1, 13.2_
    - _Design: §3.3 (module layout), §2 (transport seam)_
  - [x]* 1.3 Add host test suite for `FrameCodec` and confirm `WSServer` regression
    - Create `firmware/tests/test_frame_codec/test_frame_codec.cpp` (own `int main` with Catch2) driving `FrameCodec` directly: frame splitting, resync, oversize desync, single-client adopt/reject/close
    - Confirm the existing `test_frame` and any `WSServer` host suite still pass unchanged against the delegated core
    - _Requirements: 13.1, 13.2, 13.3_
    - _Design: §7.5 (regression)_

- [x] 2. Firmware MTU chunking/reassembly pure core (`ble_chunk`)
  - [x] 2.1 Implement `fragment()` and `Reassembler`
    - Create `firmware/src/protocol/ble_chunk.{h,cpp}`, Arduino-include-free / host-compilable
    - Chunk wire format: 1-byte header `bits[7:4]=total_chunks(1..15)`, `bits[3:0]=chunk_index(0..total-1)`, then body (slice of the `Frame_Envelope`)
    - `fragment(frame, body)`: slice into `ceil(len/body)` ordered chunks; reject `total > 15` as unrepresentable
    - `Reassembler`: track in-flight `total` and a received-index bitmask; emit the exact concatenated `Frame_Envelope` when `received == total`; expose an unrecoverable-error signal
    - Failure rules (discard partial frame + signal error): inconsistent `total` across chunks of one in-flight frame, duplicate index, index `>= total`, `total > 15`, incomplete set when a new-frame chunk starts
    - _Requirements: 5.2, 5.3, 5.5_
    - _Design: §3.6, §4.3 (BLE chunk)_
  - [x]* 2.2 Write property test for chunking round-trip identity (firmware, rapidcheck)
    - Create `firmware/tests/test_ble_chunk_props/` with rapidcheck + Catch2, 100+ iterations
    - **Property 1: Chunking round-trip byte identity** — for arbitrary `frame` (incl. min 4-byte and large HELLO/STATUS sizes) with `4 <= len <= 15*body` and arbitrary `body >= 1`, `reassemble(fragment(frame, body)) == frame`
    - Tag: `// Feature: ble-transport-switch, Property 1`
    - **Validates: Requirements 4.2, 5.1, 5.2, 5.3, 10.1, 13.3**
    - _Design: §7.1_
  - [x]* 2.3 Write property test for malformed-sequence rejection (firmware, rapidcheck)
    - Same suite/runner as 2.2, 100+ iterations
    - **Property 2: Chunk reassembly rejects malformed sequences** — for arbitrary malformed chunk sequences (drop/dup/reorder-beyond-recovery/inconsistent-total/index>=total/total>15) the reassembler discards the partial frame, signals a transmit error, and never emits a frame
    - Tag: `// Feature: ble-transport-switch, Property 2`
    - **Validates: Requirements 5.5**
    - _Design: §7.1_

- [x] 3. Firmware `BleServer` (ArduinoBLE GATT transport, BLE build)
  - [x] 3.1 Implement `BleServer` mirroring the `WSServer` seam
    - Create `firmware/src/protocol/ble_server.{h,cpp}`; header Arduino-free in the `ws_server.h` style, all `ArduinoBLE` includes/objects behind `#if defined(ARDUINO)` in the `.cpp`
    - Hold `FrameCodec codec_` and `Reassembler rx_`; expose `begin()`, `serviceLoop()`, `sendBinary(data,len)`, `onFrame(h)` (forwards to `codec_`), `isClientConnected()` (forwards to `codec_`), `lastRssiDbm()`
    - Define GATT UUID/name constants: `ESK_BLE_SERVICE_UUID 6b1d0001-...`, `ESK_BLE_RX_CHAR_UUID 6b1d0002-...`, `ESK_BLE_TX_CHAR_UUID 6b1d0003-...`, advertised name `EtchASketch`
    - Configure single bidirectional pipe: RX char (Write/WriteWithoutResponse) inbound, TX char (Notify) outbound
    - _Requirements: 2.1, 2.2, 3.1, 5.1_
    - _Design: §3.2, §3.3 (GATT), §4.5 (UUIDs)_
  - [x] 3.2 Implement inbound and outbound chunk paths
    - Inbound: RX write-handler appends each chunk to `rx_`; on complete frame pass exact bytes to `codec_.feedBytes(...)` (same `onFrame` handler as WiFi); on unrecoverable reassembly drop the partial frame and emit an `ERROR` (transmit-error) so the SPA retransmits
    - Outbound: `sendBinary(frame)` runs `fragment(frame, mtuPayload)` and writes each chunk as a TX-characteristic notification
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
    - _Design: §3.2 (inbound/outbound path), §3.6_
  - [x] 3.3 Implement single-session, advertising, and RSSI readback in `serviceLoop()`
    - On central connect, adopt via `codec_.handleNewConnection(...)` and stop advertising while connected; on disconnect resume advertising within 5 s
    - Reject a concurrent central if the stack surfaces one, preserving the active session (reuse session-busy `ERROR` kind `0x06`)
    - In `serviceLoop()`: `BLE.poll()`, drain RX into reassembler, detect disconnect, snapshot `BLEDevice::rssi()` for `lastRssiDbm()`
    - _Requirements: 2.4, 2.5, 3.4, 3.5, 3.7, 9.4_
    - _Design: §3.2 (single client), §3.8 (RSSI)_
  - [x]* 3.4 Add host-compilable test for `BleServer` non-Arduino parts and single-session invariant
    - Create `firmware/tests/test_ble_server/` exercising the host-side logic (chunk-path wiring into `FrameCodec`, transmit-error on bad reassembly) with `ArduinoBLE` stubbed/guarded out
    - **Property 3: Single BLE session invariant** — for arbitrary connect/reject/disconnect sequences at most one session is active; reuse/extend the existing `FrameCodec` single-client property coverage against the extracted core
    - Tag: `// Feature: ble-transport-switch, Property 3`
    - **Validates: Requirements 3.4, 3.5, 3.7**
    - _Design: §7.1, §7.2_

- [x] 4. Firmware build-flag transport selection and sketch wiring
  - [x] 4.1 Add `transport_config.h` and partitioned PlatformIO environments
    - Create `firmware/src/transport_config.h`: define `ETCH_TRANSPORT_BLE`/`ETCH_TRANSPORT_WIFI` codes; `#error` with valid-options message when `ETCH_TRANSPORT` is unset or unknown; map the flag to `#include` the selected server and `namespace app { using Transport = ...; }`
    - Add `[env:uno_r4_wifi_ble]` (`-D ETCH_TRANSPORT=ble`, `lib_deps` adds `ArduinoBLE` only) and `[env:uno_r4_wifi_wifi]` (`-D ETCH_TRANSPORT=wifi`, retains `ArduinoJson`; WiFiS3 auto-discovered) to `platformio.ini`
    - Ensure `ArduinoBLE` is listed in `lib_deps` for the BLE env only so the WiFi radio stack never links into the BLE image
    - _Requirements: 1.1, 1.2, 1.3, 1.5_
    - _Design: §4 (build architecture), §3.7_
  - [x] 4.2 Wire the sketch to the selected transport
    - Modify `firmware/etchasketch.ino`: replace `protocol::WSServer g_ws` with `app::Transport g_transport`; keep `handleFrame` router and every send helper (`sendFrame`/`sendAck`/`sendNack`/`sendStatus`/…) byte-identical
    - In `setup()` call `g_transport.begin(); g_transport.onFrame(handleFrame);`; in `loop()` call `g_transport.serviceLoop()` and use `g_transport.isClientConnected()`
    - Exclude WiFi managers (`g_wifi`, `g_http`, `g_ws`) from compilation under the BLE flag so WiFi is never initialized at runtime; keep the complete WiFi source in the tree
    - In the BLE build, source the STATUS `Signal_Strength` (offset 9) from `g_transport.lastRssiDbm()`
    - _Requirements: 1.4, 1.6, 9.3, 9.4, 13.1_
    - _Design: §3.7, §3.8_
  - [x]* 4.3 Add build/smoke and negative-build verification
    - Verify `pio run -e uno_r4_wifi_wifi` builds (and `-e uno_r4_wifi_ble` host-compiles the non-Arduino parts; full BLE link is HIL)
    - Negative build: `ETCH_TRANSPORT` unset and a bogus value each fail with the documented diagnostic listing valid options
    - Source-presence check: complete WiFi transport remains in the tree; single shared `frame.*`/`frame_codec.*` (no per-transport fork)
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 13.4, 13.5_
    - _Design: §7.3_

- [x] 5. Checkpoint - firmware core builds and host tests pass
  - Run `cd firmware && pio test -e host_test`; run `cd firmware && pio run -e uno_r4_wifi_wifi`.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Web MTU chunking/reassembly pure core
  - [x] 6.1 Implement pure `fragment()`/`reassemble` chunk module
    - Create `web/src/net/ble_chunk.ts` (pure, no Web Bluetooth deps), mirroring the firmware chunk wire format exactly (1-byte `total<<4 | index` header + body)
    - `fragment(frameBytes, body)`: ordered chunks, reject `total > 15`
    - Reassembler: track `total` + received-index set; emit exact `Frame_Envelope` on completion; signal unrecoverable error on inconsistent total / duplicate index / index>=total / total>15 / incomplete-on-new-frame
    - _Requirements: 5.2, 5.3, 5.5_
    - _Design: §3.6, §4.3_
  - [x]* 6.2 Write property test for chunking round-trip identity (web, fast-check)
    - Create `web/src/net/ble_chunk.props.test.ts` (Vitest + fast-check), 100+ runs
    - **Property 1: Chunking round-trip byte identity** — arbitrary frames × arbitrary `body >= 1` with `4 <= len <= 15*body` satisfy `reassemble(fragment(frame, body)) == frame`
    - Tag: `// Feature: ble-transport-switch, Property 1`
    - **Validates: Requirements 4.2, 5.1, 5.2, 5.3, 10.1, 13.3**
    - _Design: §7.1_
  - [x]* 6.3 Write property test for malformed-sequence rejection (web, fast-check)
    - Same suite as 6.2, 100+ runs
    - **Property 2: Chunk reassembly rejects malformed sequences** — arbitrary malformed sequences are discarded with a transmit error and never emit a frame
    - Tag: `// Feature: ble-transport-switch, Property 2`
    - **Validates: Requirements 5.5**
    - _Design: §7.1_

- [x] 7. Web `BleSocket` (`WireSocket` adapter over Web Bluetooth)
  - [x] 7.1 Implement `BleSocket` with injectable GATT dependencies
    - Create `web/src/net/ble_socket.ts` implementing `WireSocket` (`binaryType`, `readyState`, `send`, `close`, `onopen/onmessage/onerror/onclose`)
    - Define `BleGattDeps` (`requestDevice()` wrapping `navigator.bluetooth.requestDevice({filters:[{services:[SERVICE_UUID]}]})`) so the socket is unit-testable with a fake characteristic
    - Define shared UUID/name constants matching firmware (`ESK_BLE_SERVICE_UUID`/`RX`/`TX`, `EtchASketch`)
    - Connect flow: `requestDevice` → `gatt.connect()` → `getPrimaryService` → `getCharacteristic(RX/TX)` → `txChar.startNotifications()` + subscribe `characteristicvaluechanged` → `readyState=OPEN`, fire `onopen`
    - `send`: `fragment(frameBytes, negotiatedMtuPayload)` → `rxChar.writeValueWithoutResponse(chunk)` per chunk (streaming, incremental)
    - Receive: each TX notification → reassembler → `onmessage({data: ArrayBuffer})` with exact `Frame_Envelope` bytes; unrecoverable reassembly → `onerror`
    - _Requirements: 3.1, 3.2, 5.1, 5.2, 5.4, 5.5_
    - _Design: §3.4_
  - [x] 7.2 Implement error distinction and reconnect-to-same-device
    - Discovery failure (`requestDevice`/service/characteristic/`startNotifications` throws before open) rejects connect as a *discovery* error, distinct from a post-open *disconnect*
    - Map GATT `gattserverdisconnected` → `onclose` so `WireClient`'s existing reconnect window runs unchanged; reconnect re-`gatt.connect()`s the retained same `BluetoothDevice` (no new chooser)
    - _Requirements: 3.6, 12.5_
    - _Design: §3.4 (error distinction), §3.9_
  - [x]* 7.3 Write unit tests for `BleSocket` with a fake GATT characteristic
    - Create `web/src/net/ble_socket.test.ts`: connect ordering (discover → `startNotifications` → `onopen`); `send` fragments and calls `writeValueWithoutResponse` per chunk; inbound notifications reassemble and fire `onmessage({data})`; discovery-failure vs post-open-disconnect distinction; reconnect-to-same-device on drop
    - _Requirements: 3.1, 3.2, 3.6, 5.1, 5.2, 12.5_
    - _Design: §7.2_

- [x] 8. Web transport selection (single config point) and wiring
  - [x] 8.1 Add single transport-selection point and `makeSocketFactory`
    - Modify `web/src/app/config.ts`: `export const TRANSPORT = (import.meta.env.VITE_ESK_TRANSPORT ?? 'ble')`; add `makeSocketFactory(): SocketFactory`
    - BLE branch: if `!('bluetooth' in navigator)` throw `TransportUnavailableError('ble', 'Bluetooth requires Chrome or Edge. Use the WiFi build for Safari/Firefox.')`; else return a factory producing `new BleSocket(defaultBleDeps())`
    - WebSocket branch: return a factory producing `new WebSocket(url)` as `WireSocket`
    - No silent fallback: a configured-but-unavailable transport fails with a clear error naming the unavailable transport
    - _Requirements: 4.4, 4.5, 4.6_
    - _Design: §3.5_
  - [x] 8.2 Wire the factory into the controller/main entry
    - Update the SPA entry (`web/src/main.ts` / `controller.ts`) to obtain the `SocketFactory` from `makeSocketFactory()` and hand it to `WireClient`; UI panels remain unchanged so the UI renders identically across transports
    - _Requirements: 4.1, 4.2, 4.3_
    - _Design: §2 (transport seam), §3.5_
  - [x]* 8.3 Write unit tests for `makeSocketFactory` branches
    - Create/extend a config test: BLE-selected with `navigator.bluetooth` present returns a `BleSocket` factory; BLE-selected without `navigator.bluetooth` throws `TransportUnavailableError` with Chrome/Edge + WiFi-alternative guidance and no fallback; WebSocket-selected returns a WebSocket factory
    - _Requirements: 4.4, 4.5, 4.6_
    - _Design: §7.2_

- [x] 9. Web build-time transport define and bundle verification
  - [x] 9.1 Add Vite env define for transport selection
    - Wire `VITE_ESK_TRANSPORT` (`'ble' | 'websocket'`, default `ble`) through `web/vite.config.ts` / env so the single config point resolves at build time
    - _Requirements: 4.4_
    - _Design: §3.5, §4_
  - [x]* 9.2 Verify both transport builds produce a valid bundle
    - Build with `VITE_ESK_TRANSPORT=ble` and with `=websocket`; assert each `npm run build` succeeds and emits a valid bundle
    - _Requirements: 4.4, 13.2_
    - _Design: §7.3_

- [x] 10. Checkpoint - web tests and builds pass
  - Run `cd web && npm test`; run `cd web && npm run build`.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Regression - reused protocol logic (Properties 4–11) still green
  - [x]* 11.1 Confirm web `WireClient` property/unit suites pass unchanged
    - Run the existing `web/src/net/wire_client.props.test.ts` and `wire_client.test.ts` against the new `WireSocket`/`SocketFactory` wiring; they cover **Property 4 (bounded retransmission)**, **Property 5 (flow-control gating)**, and **Property 10 (reconnect window)** — confirm no behavioral change
    - **Validates: Requirements 6.5, 7.2, 7.4, 7.6, 11.4, 12.2, 12.4**
    - _Design: §7.1, §7.5_
  - [x]* 11.2 Confirm firmware reused-logic host suites pass unchanged
    - Run the existing flow-control, command/control validator, and diagnostics host suites; they cover **Property 6 (credit hysteresis)**, **Property 7 (range no-clamp)**, **Property 8 (CRC short-circuit)**, **Property 9 (one ERROR per fault)**, and **Property 11 (CRC preservation/tamper)** — confirm the `FrameCodec` extraction did not change behavior
    - **Validates: Requirements 6.1, 6.3, 6.7, 7.3, 10.10, 10.11, 11.5**
    - _Design: §7.1, §7.5_

- [x] 12. Final checkpoint - full test + build matrix
  - Run `cd web && npm test` and `cd web && npm run build` (both transport defines).
  - Run `cd firmware && pio test -e host_test` and `cd firmware && pio run -e uno_r4_wifi_wifi`.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. HIL / manual verification (REQUIRES REAL HARDWARE — non-blocking)
  - NOTE: The following items require a physical Arduino UNO R4 WiFi flashed with the BLE image (`pio run -e uno_r4_wifi_ble -t upload`) and a Chromium-based browser (Chrome/Edge). They CANNOT be completed by a coding agent and MUST NOT block the codeable/testable tasks above.
  - [~] 13.1 Advertising & discovery: confirm the board advertises service UUID + name `EtchASketch` and is selectable via `requestDevice` filter; not connectable while a central is connected; re-advertises within 5 s of disconnect
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [~] 13.2 End-to-end connect → HELLO → stream a drawing → telemetry; confirm byte-identity with the WiFi build
    - _Requirements: 3.1, 3.2, 3.3, 4.2_
  - [~] 13.3 Throughput: sustain command delivery ≥ motor feed rate for 100–1000 sps without Motion_Buffer_Starvation; confirm negotiated MTU and connection interval
    - _Requirements: 8.1, 8.2, 8.4_
  - [~] 13.4 Telemetry: STATUS cadence ≥ 1 Hz drawing / ≥ 0.2 Hz idle; RSSI reflects real link RSSI
    - _Requirements: 9.1, 9.2, 9.4_
  - [~] 13.5 Disconnect/reconnect: mid-draw drop reconnects within 60 s and resumes; window expiry aborts with `CONN_TIMEOUT` on next connect
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

## Notes

- Tasks marked with `*` are optional (tests/verification) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Properties 1 and 2 (the new chunking/reassembly core) get fresh property-based tests in BOTH languages (rapidcheck+Catch2 firmware, fast-check+Vitest web), 100+ iterations, tagged `Feature: ble-transport-switch, Property {n}`.
- Properties 3–11 cover logic reused unchanged from `FrameCodec`/`WireClient`/validators/flow-control; the plan re-runs the existing suites (tasks 3.4, 11.1, 11.2) rather than rewriting them.
- The wire protocol does not change: `frame.*`, `Drawing_Command`, control/telemetry layouts stay byte-identical across builds (Req 13.3, 13.4).
- Section 13 is HIL/manual and requires real hardware + a Chromium browser; it is intentionally non-blocking and excluded from the dependency graph.
- `pio` is at `~/Library/Python/3.13/bin/pio`; ensure it is on PATH when running firmware tests.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "6.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3", "6.2", "6.3", "7.1"] },
    { "id": 3, "tasks": ["3.1", "7.2"] },
    { "id": 4, "tasks": ["3.2", "3.3", "7.3", "8.1"] },
    { "id": 5, "tasks": ["3.4", "4.1", "8.2", "9.1"] },
    { "id": 6, "tasks": ["4.2", "8.3", "9.2"] },
    { "id": 7, "tasks": ["4.3"] },
    { "id": 8, "tasks": ["11.1", "11.2"] }
  ]
}
```

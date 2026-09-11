# Requirements Document

## Introduction

This feature changes the primary browser-to-controller transport of the Etch-a-Sketch Drawing Machine from WiFi (WebSocket on port 81 plus an HTTP server on port 80) to Bluetooth Low Energy (BLE), while keeping the existing WiFi transport intact in the codebase as a compile-time-selectable fallback.

The motivation is to eliminate WiFi setup friction (AP-mode provisioning, unfinished mDNS, and the lack of internet access on the AP network, which breaks image edge-detection that fetches opencv.js from a CDN). BLE lets a Chrome/Edge browser connect directly to the controller using Web Bluetooth without joining a network.

A hard hardware constraint shapes this feature: on the Arduino UNO R4 WiFi, both WiFi (WiFiS3) and BLE (ArduinoBLE) run on the same ESP32-S3 radio coprocessor, and the stock Arduino firmware does not reliably support running WiFi and BLE concurrently. The two transports are therefore mutually exclusive and selected at compile time via a build flag, not at runtime. The WiFi code remains in the source tree behind the flag so a WiFi image can be rebuilt at any time.

BLE must preserve the full feature set the WiFi transport provides today: streaming of 16-byte Drawing_Command frames inside the binary frame envelope (version/type/length/payload), CRC-validated commands with ACK/NACK/RETX, credit-based flow control feeding the firmware's 32-deep command ring buffer, STATUS telemetry, STATE updates, ERROR frames, and the full set of control messages. The browser-side connection layer abstracts BLE versus WebSocket so the same SPA UI works against either firmware build.

This spec does NOT address the separate drawing-output calibration/orientation issue (off-canvas drawing); that remains a separate effort.

## Glossary

- **Controller**: The Arduino UNO R4 WiFi board (Renesas RA4M1 main MCU plus ESP32-S3 radio coprocessor) running the firmware.
- **RA4M1**: The main microcontroller on the Controller that owns motion, the command ring buffer, and protocol logic.
- **ESP32_S3**: The radio coprocessor on the Controller that owns the radio transport (WiFi today, BLE in this feature). Cannot run WiFi and BLE concurrently in stock firmware.
- **BLE**: Bluetooth Low Energy, the new primary radio transport between the browser and the Controller.
- **BLE_Transport**: The firmware component that exposes the GATT service and characteristics, and bridges BLE traffic to the RA4M1 protocol layer.
- **WiFi_Transport**: The existing firmware transport (WebSocket plus HTTP) retained as a compile-time fallback.
- **Transport_Build_Flag**: The compile-time configuration value that selects exactly one of BLE_Transport or WiFi_Transport for a given firmware image.
- **SPA**: The browser single-page application (Preact + TypeScript) that creates drawings and streams commands.
- **Connection_Layer**: The browser-side abstraction that hides whether the active transport is BLE (Web Bluetooth) or WebSocket.
- **Web_Bluetooth**: The browser API (available in Chrome and Edge) the SPA uses to communicate over BLE.
- **GATT**: The BLE Generic Attribute Profile that defines services and characteristics.
- **GATT_Service**: The BLE service the Controller advertises that contains the command, telemetry, and control characteristics.
- **MTU**: The BLE Maximum Transmission Unit, the largest payload that fits in a single BLE packet for the negotiated connection.
- **Frame_Envelope**: The existing binary message envelope (version u8, type u8, length u16, payload bytes) shared by all transports.
- **Drawing_Command**: The fixed 16-byte little-endian motion command payload (seq, dx, dy, feed, flags, reserved, crc16).
- **Control_Message**: A CTL-type message carrying one of pause/resume/cancel/stop/jog/setHome/reHome/beginDraw/endDraw/speedPct/setBacklash/motorTest/faultReset.
- **STATUS**: The telemetry frame carrying logical position, percent complete, signal strength, active speed, state code, and flags.
- **STATE**: The frame reporting the Controller's drawing state (idle/drawing/paused/fault/stall/aborted).
- **CREDIT**: The flow-control frame granting the SPA permission to send additional Drawing_Commands.
- **ERROR**: The frame reporting a fault, stall, unrecoverable transmit failure, connection timeout, or home-required condition.
- **Command_Ring_Buffer**: The firmware's 32-deep FIFO of Drawing_Commands fed by the transport and drained by the motion planner.
- **Motion_Buffer_Starvation**: The condition where the Command_Ring_Buffer empties while a drawing is still in progress, causing the motors to stall waiting for data.
- **Signal_Strength**: The connection quality metric reported in STATUS (RSSI in dBm for the active transport).

## Requirements

### Requirement 1: Compile-Time Transport Selection

**User Story:** As a firmware builder, I want to choose BLE or WiFi at build time with a single flag, so that I can produce a BLE image by default and still rebuild a WiFi image when needed.

#### Acceptance Criteria

1. THE Controller firmware SHALL provide a Transport_Build_Flag that selects exactly one transport, either BLE_Transport or WiFi_Transport, for a given firmware image.
2. WHERE the Transport_Build_Flag selects BLE_Transport, THE Controller SHALL compile and link BLE_Transport and SHALL exclude WiFi_Transport networking code from the produced image.
3. WHERE the Transport_Build_Flag selects WiFi_Transport, THE Controller SHALL compile and link WiFi_Transport and SHALL exclude BLE_Transport networking code from the produced image.
4. THE Controller SHALL retain the complete WiFi_Transport source in the codebase regardless of the Transport_Build_Flag value.
5. IF the Transport_Build_Flag is unset or set to an unrecognized value, THEN THE Controller build SHALL fail with a diagnostic message identifying the valid transport options.
6. WHERE the Transport_Build_Flag selects BLE_Transport, THE Controller SHALL NOT initialize WiFi_Transport at runtime, so that WiFi and BLE never run concurrently on the ESP32_S3.

### Requirement 2: BLE Advertisement and Discovery

**User Story:** As a user, I want the machine to advertise itself over BLE, so that my Chrome or Edge browser can find and select it.

#### Acceptance Criteria

1. WHERE the Transport_Build_Flag selects BLE_Transport, THE Controller SHALL advertise a BLE GATT_Service with a fixed service identifier when no client is connected.
2. THE Controller SHALL advertise a human-readable device name that identifies the device as an Etch-a-Sketch machine.
3. WHEN the SPA initiates a Web_Bluetooth device request filtered by the Controller's GATT_Service identifier, THE Connection_Layer SHALL present the Controller as a selectable device.
4. WHILE a BLE client is connected, THE Controller SHALL stop advertising new connectability so that only one client session is active at a time.
5. WHEN the connected BLE client disconnects, THE Controller SHALL resume advertising within 5 seconds so that a client can reconnect.

### Requirement 3: BLE Connection and Session Establishment

**User Story:** As a user, I want to connect to the machine over BLE from the browser, so that I can start sending drawings without joining a network.

#### Acceptance Criteria

1. WHEN the SPA selects the Controller through Web_Bluetooth, THE Connection_Layer SHALL connect to the GATT_Service and discover its command, telemetry, and control characteristics.
2. WHEN the GATT_Service characteristics are discovered, THE Connection_Layer SHALL enable notifications on every characteristic the Controller uses to send data to the SPA.
3. WHEN a BLE session is established, THE Controller SHALL send the existing session-initialization frame (HELLO) carrying firmware version, calibration state, and persisted configuration through the telemetry path.
4. THE Controller SHALL accept at most one BLE client session at a time.
5. IF a second BLE client attempts to connect while a session is active, THEN THE Controller SHALL reject the additional connection so that the active session is preserved.
6. IF the BLE connection or GATT discovery fails, THEN THE Connection_Layer SHALL report a connection error to the user that distinguishes a discovery failure from a disconnect.
7. WHILE no BLE session is active, THE Controller SHALL allow multiple clients to attempt to connect simultaneously, and THE Controller SHALL establish the session with the first client to complete connection and SHALL reject the remaining clients per acceptance criteria 4 and 5.

### Requirement 4: Transport-Agnostic Browser Connection Layer

**User Story:** As a developer, I want the same SPA UI to work over BLE or WebSocket, so that I do not maintain two user interfaces.

#### Acceptance Criteria

1. THE Connection_Layer SHALL expose a single interface for sending Drawing_Commands and Control_Messages and for receiving STATUS, STATE, CREDIT, ERROR, ACK, NACK, and RETX events, independent of whether the active transport is BLE or WebSocket.
2. WHERE the active transport is BLE, THE Connection_Layer SHALL transmit and receive the same Frame_Envelope and payload byte layouts used by the WebSocket transport.
3. THE SPA UI SHALL render drawing, telemetry, and control affordances identically regardless of the active transport.
4. WHEN the SPA is built, THE Connection_Layer SHALL select the BLE or WebSocket implementation through a single configuration point.
5. IF Web_Bluetooth is unavailable in the current browser, THEN THE Connection_Layer SHALL report that BLE requires Chrome or Edge and SHALL identify the WiFi build as the alternative for other browsers.
6. IF the transport selected at the single configuration point is unavailable at runtime in the browser, THEN THE Connection_Layer SHALL fail with a clear error identifying the unavailable transport and SHALL NOT silently fall back to the other transport.

### Requirement 5: Streaming Drawing Commands over BLE

**User Story:** As a user, I want my drawing to stream to the machine over BLE the same way it does over WiFi, so that large drawings run without bulk upload.

#### Acceptance Criteria

1. WHEN the SPA sends a Drawing_Command, THE BLE_Transport SHALL deliver the exact 16-byte Drawing_Command payload to the RA4M1 protocol layer.
2. WHERE a Frame_Envelope and its payload exceed the negotiated BLE MTU, THE Connection_Layer SHALL split the frame into ordered BLE chunks and THE BLE_Transport SHALL reassemble the chunks into the original Frame_Envelope before delivering it to the RA4M1 protocol layer.
3. WHEN the BLE_Transport reassembles a Frame_Envelope, THE reassembled bytes SHALL be identical to the bytes the SPA emitted (round-trip preservation across chunking).
4. THE BLE_Transport SHALL preserve the streaming model in which Drawing_Commands are sent incrementally rather than uploaded as one bulk transfer.
5. IF a BLE chunk sequence is incomplete or arrives out of order beyond what reassembly can resolve, THEN THE BLE_Transport SHALL discard the partial frame and SHALL signal a transmit error so that the SPA can retransmit.

### Requirement 6: Command Integrity and Reliable Delivery over BLE

**User Story:** As a user, I want commands validated and retransmitted on error over BLE, so that drawings are not corrupted by a lossy radio link.

#### Acceptance Criteria

1. WHEN the RA4M1 protocol layer receives a Drawing_Command over BLE, THE Controller SHALL validate the 16-bit CRC and field ranges using the same canonical rules as the WiFi transport.
2. WHEN a Drawing_Command passes validation, THE Controller SHALL send an ACK referencing the command sequence number.
3. IF a received Drawing_Command fails CRC validation, THEN THE Controller SHALL send a RETX request referencing the command sequence number.
5. WHEN the SPA receives a RETX request for a Drawing_Command, THE Connection_Layer SHALL retransmit that command up to two additional times, counting the original transmission as attempt one for a maximum of three total attempts, before reporting an unrecoverable transmit error.
6. THE BLE_Transport SHALL carry ACK, NACK, and RETX frames using the same Frame_Envelope type codes as the WiFi transport.
7. IF a received Drawing_Command fails CRC validation, THEN THE Controller SHALL report the CRC failure by requesting a RETX only and SHALL skip field-range validation for that command, so that a CRC-invalid command does not also produce a range NACK.

### Requirement 7: Credit-Based Flow Control over BLE

**User Story:** As a user, I want flow control over BLE that matches the firmware's buffer, so that fast sending never overflows the 32-deep command buffer.

#### Acceptance Criteria

1. WHEN a BLE drawing session begins, THE Controller SHALL grant an initial CREDIT equal to the Command_Ring_Buffer capacity of 32.
2. WHEN the Controller consumes a Drawing_Command from the Command_Ring_Buffer, THE Controller SHALL emit a CREDIT increment over BLE for the freed slot.
3. WHILE the Command_Ring_Buffer occupancy is at or above the high-water mark of 28, THE Controller SHALL withhold CREDIT increments until occupancy drains to the low-water mark of 16.
4. WHILE the SPA holds zero credits, THE Connection_Layer SHALL withhold further Drawing_Commands until a CREDIT is received.
5. IF a Drawing_Command arrives when the Command_Ring_Buffer is full, THEN THE Controller SHALL send a NACK with a buffer-full reason and SHALL NOT enqueue the command.
6. WHILE the SPA holds at least one credit, THE Connection_Layer SHALL be permitted to send pending Drawing_Commands without withholding on the basis of credit availability.

### Requirement 8: Throughput Sufficient to Keep Motors Fed

**User Story:** As a user, I want BLE to deliver commands fast enough that the motors never stall waiting for data, so that drawings run continuously even though BLE is slower than WiFi.

#### Acceptance Criteria

1. WHILE a drawing is in progress and the SPA has credits and pending Drawing_Commands, THE BLE_Transport SHALL sustain a command delivery rate that is at least equal to the active motor feed rate so that the Command_Ring_Buffer remains non-empty, for motor feed rates between 100 and 1000 steps per second, where a delivery rate exactly equal to the motor feed rate is acceptable and no additional safety-margin beyond keeping the buffer non-empty is required.
2. WHILE a drawing is in progress over BLE, THE Controller SHALL NOT experience Motion_Buffer_Starvation caused by transport delivery rate when credits and pending commands are available.
3. IF Motion_Buffer_Starvation occurs during a BLE drawing, THEN THE Controller SHALL pause motion and SHALL report a transport throughput condition to the SPA rather than producing distorted motion.
4. THE Connection_Layer SHALL request a BLE connection interval and MTU that support the sustained command rate required by acceptance criterion 1.

### Requirement 9: Telemetry and State Reporting over BLE

**User Story:** As a user, I want live position, signal, state, and progress over BLE, so that I can monitor a drawing exactly as I do over WiFi.

#### Acceptance Criteria

1. WHILE a drawing is in progress, THE Controller SHALL send STATUS telemetry over BLE at a hard minimum rate of 1 Hz regardless of any configured value.
2. WHILE the Controller is idle, THE Controller SHALL send STATUS telemetry over BLE at a hard minimum rate of 0.2 Hz regardless of any configured value.
3. THE STATUS telemetry SHALL carry logical X and Y position in steps, percent complete, Signal_Strength, active speed, state code, and status flags.
4. WHERE the active transport is BLE, THE Controller SHALL populate the Signal_Strength field with the BLE connection RSSI in dBm.
5. WHEN the Controller's drawing state changes among idle, drawing, paused, fault, stall, and aborted, THE Controller SHALL send a STATE frame reflecting the new state over BLE.
6. WHEN motion progresses, THE Controller SHALL send PROGRESS information carrying completed steps and total steps over BLE.

### Requirement 10: Control Messages over BLE

**User Story:** As a user, I want every control action available over BLE, so that I can operate the machine fully without WiFi.

#### Acceptance Criteria

1. WHEN the SPA sends a Control_Message over BLE, THE BLE_Transport SHALL deliver the control payload to the RA4M1 protocol layer using the existing Control_Message layout.
2. THE BLE_Transport SHALL support the pause, resume, cancel, and stop Control_Messages.
3. THE BLE_Transport SHALL support the jog Control_Message carrying axis, direction, and step count.
4. THE BLE_Transport SHALL support the setHome and reHome Control_Messages.
5. THE BLE_Transport SHALL support the beginDraw and endDraw Control_Messages.
6. THE BLE_Transport SHALL support the speedPct Control_Message carrying a speed percentage between 25 and 100.
7. THE BLE_Transport SHALL support the setBacklash Control_Message carrying X and Y backlash values between 0 and 200.
8. THE BLE_Transport SHALL support the motorTest and faultReset Control_Messages.
9. WHEN the Controller accepts a Control_Message over BLE, THE Controller SHALL respond using the same ACK or NACK semantics used by the WiFi transport.
10. IF a speedPct Control_Message carries a speed percentage outside the range 25 to 100, THEN THE Controller SHALL reject the Control_Message with a NACK identifying the out-of-range field and SHALL NOT clamp the value.
11. IF a jog or setBacklash Control_Message carries a range-checked field outside its defined range, THEN THE Controller SHALL reject the Control_Message with a NACK identifying the out-of-range field and SHALL NOT clamp the value, consistent with the existing range-validation behavior.

### Requirement 11: Error and Fault Reporting over BLE

**User Story:** As a user, I want faults and stalls reported over BLE, so that I see the same safety information available over WiFi.

#### Acceptance Criteria

1. WHEN the Controller detects a motor stall, THE Controller SHALL send an ERROR frame over BLE identifying the stall kind and the affected axis.
2. WHEN the Controller detects a driver fault, THE Controller SHALL send an ERROR frame over BLE identifying the fault kind and the affected axis.
3. WHEN the SPA sends a faultReset Control_Message over BLE, THE Controller SHALL clear active stall and fault conditions and SHALL report the resulting state.
4. WHEN an unrecoverable transmit failure occurs after exhausted retransmissions, THE Connection_Layer SHALL report the unrecoverable transmit error to the user.
5. WHEN the Controller detects multiple distinct faults simultaneously, THE Controller SHALL send a separate ERROR frame over BLE for each detected fault type rather than combining multiple fault types into a single ERROR frame.

### Requirement 12: Disconnect and Reconnect Handling over BLE

**User Story:** As a user, I want a brief BLE dropout during a drawing to be recoverable, so that a momentary radio glitch does not ruin my drawing.

#### Acceptance Criteria

1. WHEN the BLE connection drops while a drawing is in progress, THE Controller SHALL pause motion and SHALL retain the current logical position and the contents of the Command_Ring_Buffer.
2. WHILE the BLE connection is dropped during a drawing, THE Controller SHALL accept reconnection attempts from a client within a 60-second reconnect window, where accepting an attempt within the window does not guarantee a successful reconnection.
3. WHEN a client reconnects within the reconnect window, THE Controller SHALL send a session-initialization frame carrying the paused state, last acknowledged sequence number, and current position so that the SPA can resume.
4. IF the 60-second reconnect window expires without a reconnection, THEN THE Controller SHALL abort the drawing, retain the last logical position, and report a connection-timeout ERROR on the next connection.
5. WHEN the BLE connection drops, THE Connection_Layer SHALL report a reconnecting status to the user and SHALL attempt to reconnect to the same Controller.

### Requirement 13: Preserving the WiFi Fallback Build

**User Story:** As a user on Safari or Firefox, I want a WiFi build that still works, so that I am not forced to use BLE.

#### Acceptance Criteria

1. WHERE the Transport_Build_Flag selects WiFi_Transport, THE Controller SHALL provide the complete WiFi feature set, including STA connection, AP-mode fallback, the HTTP server, and the WebSocket command channel, unchanged by this feature.
2. WHERE the Transport_Build_Flag selects WiFi_Transport, THE SPA Connection_Layer SHALL communicate over WebSocket using the existing Frame_Envelope and payloads.
3. THE Frame_Envelope, Drawing_Command, Control_Message, STATUS, STATE, CREDIT, and ERROR byte layouts SHALL be identical across the BLE and WiFi builds.
4. WHEN a change is made to a shared protocol byte layout, THE change SHALL apply to both the BLE and WiFi builds so that the protocol does not diverge between transports.
5. WHERE the Transport_Build_Flag selects WiFi_Transport, THE Controller SHALL require all of the STA connection, AP-mode fallback, HTTP server, and WebSocket command channel features to be functional for the WiFi build to be valid, so that a build providing only a subset of these features is not a valid WiFi build.

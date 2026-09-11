# Requirements Document

## Introduction

This feature replaces the dangerous, hard-coded gear-math scaling that maps drawing millimetres to motor steps with a dummy-proof, visual two-corner calibration that requires no physical measuring tools. Today the browser converts mm to steps via a fixed `mm_per_rev` constant (`web/src/constants.ts` `DEFAULT_MM_PER_REV_X/Y = 3.4`, yielding ~117.6 steps/mm and ~17,900 steps across the 152 mm axis). That value commands far more travel than the machine physically has, so the motors slam the axes into their mechanical limits.

The fix is a Visual_Calibration flow in which the user jogs the stylus by eye to two corners. The bottom-left corner is captured as home (logical 0,0). The top-right corner is then captured, and the firmware reports its own accumulated step counts to yield the real travel envelope in motor steps (Envelope_X_Steps, Envelope_Y_Steps). Drawings are then fit into that measured Step_Envelope preserving aspect ratio (letterbox/center, no stretch), and the measured envelope replaces the `mm_per_rev` gear math for final mm-to-steps scaling whenever a calibrated envelope exists.

The envelope is persisted in firmware NVM alongside the existing backlash fields, surfaced in the HELLO and STATUS frames mirroring how backlash and the existing calibrated flag are surfaced, and gated so that drawing is blocked until the machine is envelope-calibrated. A fixed per-session firmware travel safety cap prevents jogs from driving the axes beyond a generous step limit, active even before any corner is captured. The flow assumes square axes with no skew correction, and reuses the existing jog controls, Set Home action, and STATUS position readout. Re-flashing firmware to adopt the new NVM record version is acceptable.

## Glossary

- **Controller**: The Arduino UNO R4 WiFi board running the firmware that owns motion, persistence, and protocol logic.
- **SPA**: The browser single-page application (Preact + TypeScript) that creates drawings and streams commands to the Controller.
- **Visual_Calibration**: The two-corner, jog-by-eye calibration flow that captures the travel envelope without any physical measuring instrument.
- **Bottom_Left_Corner**: The first calibration corner the user jogs to by eye; capturing it establishes home at logical position (0,0).
- **Top_Right_Corner**: The second calibration corner the user jogs to by eye; capturing it records the far extent of travel in motor steps.
- **Step_Envelope**: The calibrated travel area measured in motor steps, expressed as Envelope_X_Steps and Envelope_Y_Steps.
- **Envelope_X_Steps**: The Controller-reported accumulated motor-step count along the X axis from the Bottom_Left_Corner to the Top_Right_Corner.
- **Envelope_Y_Steps**: The Controller-reported accumulated motor-step count along the Y axis from the Bottom_Left_Corner to the Top_Right_Corner.
- **Home_Set_State**: The condition in which the Bottom_Left_Corner has been captured and logical position (0,0) is established.
- **Envelope_Captured_State**: The condition in which both corners have been captured and a valid Step_Envelope is stored.
- **Envelope_Calibrated_State**: The composite condition, requiring both Home_Set_State and Envelope_Captured_State, under which drawing is permitted.
- **Fit_To_Envelope**: The transformation that scales a drawing to fit inside the Step_Envelope while preserving aspect ratio, centering the drawing and letterboxing unused space, without stretching.
- **Gear_Math_Scaling**: The legacy mm-to-steps conversion derived from the `mm_per_rev` constant in `web/src/constants.ts`.
- **Drawing_Gate**: The send-time guard that blocks drawing commands until the Controller is in Envelope_Calibrated_State.
- **Jog_Travel_Cap**: The fixed per-session firmware limit on accumulated jog travel in motor steps per axis, larger than any expected envelope, that refuses jogs which would exceed it.
- **Capture_Bottom_Left_Message**: The control message that instructs the Controller to set home at the current stylus position and begin envelope measurement.
- **Capture_Top_Right_Message**: The control message that instructs the Controller to record the current accumulated step counts as the Step_Envelope.
- **PersistedConfig**: The firmware NVM record (in `firmware/src/types.h`) that stores configuration and calibration data across reboots.
- **NVM**: The Controller's non-volatile memory that retains the PersistedConfig record across power cycles.
- **HELLO_Frame**: The session-initialization frame the Controller sends on connection, carrying firmware version and calibration state.
- **STATUS_Frame**: The telemetry frame carrying logical position, state, and status flags.
- **CTL_Message**: A control-type message whose first byte is a kind code, optionally followed by a per-kind payload, shared between firmware and the SPA.
- **Wire_Layout**: The byte-level field layout of a frame or message, maintained as a single source of truth shared by firmware and the SPA.

## Requirements

### Requirement 1: Visual Two-Corner Capture Flow

**User Story:** As a user with no measuring tools, I want to jog to two corners by eye and capture them, so that the machine learns its real travel area without any physical measurement.

#### Acceptance Criteria

1. THE SPA SHALL present a Visual_Calibration flow that reuses the existing jog controls and the STATUS position readout to position the stylus.
2. WHEN the user jogs the stylus to the Bottom_Left_Corner and triggers the bottom-left capture, THE SPA SHALL send a Capture_Bottom_Left_Message to the Controller.
3. WHEN the Controller receives a Capture_Bottom_Left_Message, THE Controller SHALL set the current stylus position as logical home (0,0) and SHALL enter Home_Set_State.
4. WHEN the user jogs the stylus to the Top_Right_Corner and triggers the top-right capture, THE SPA SHALL send a Capture_Top_Right_Message to the Controller.
5. WHEN the Controller receives a Capture_Top_Right_Message, THE Controller SHALL record the accumulated motor-step counts since the Bottom_Left_Corner as Envelope_X_Steps and Envelope_Y_Steps.
6. THE Controller SHALL measure the Step_Envelope from the Controller's own accumulated step counts rather than from any value supplied by the SPA.
7. IF the Controller receives a Capture_Top_Right_Message while not in Home_Set_State, THEN THE Controller SHALL reject the message with a NACK identifying that home is not set and SHALL NOT record a Step_Envelope.
8. THE Visual_Calibration flow SHALL treat the X and Y axes as square and orthogonal and SHALL NOT apply skew correction.

### Requirement 2: Envelope Validity

**User Story:** As a user, I want the machine to accept only a sensible envelope, so that an accidental capture does not produce a broken calibration.

#### Acceptance Criteria

1. WHEN the Controller records a Step_Envelope from a Capture_Top_Right_Message, THE Controller SHALL accept the Step_Envelope only WHERE Envelope_X_Steps is greater than zero and Envelope_Y_Steps is greater than zero.
2. IF a Capture_Top_Right_Message yields an Envelope_X_Steps or Envelope_Y_Steps of zero or a negative accumulated count, THEN THE Controller SHALL reject the capture with a NACK identifying the invalid envelope and SHALL retain the prior Envelope_Captured_State as cleared.
3. WHEN the Controller accepts a valid Step_Envelope, THE Controller SHALL enter Envelope_Captured_State.

### Requirement 3: Fit-to-Envelope Rescaling

**User Story:** As a user, I want my drawing to fit the measured area without distortion, so that it lands on the canvas at the right proportions.

#### Acceptance Criteria

1. WHERE the Controller is in Envelope_Calibrated_State, THE SPA SHALL convert drawing coordinates to motor steps using the Step_Envelope and SHALL NOT use Gear_Math_Scaling for final mm-to-steps conversion.
2. WHEN the SPA applies Fit_To_Envelope, THE SPA SHALL scale the drawing to fit within Envelope_X_Steps and Envelope_Y_Steps while preserving the drawing's aspect ratio.
3. WHEN the SPA applies Fit_To_Envelope, THE SPA SHALL center the drawing within the Step_Envelope and SHALL letterbox the unused area rather than stretching the drawing.
4. THE SPA SHALL constrain every emitted drawing coordinate to remain within the inclusive bounds of zero and the corresponding Step_Envelope axis value.

### Requirement 4: Drawing Gate on Envelope Calibration

**User Story:** As a user, I want drawing blocked until calibration is complete, so that the machine never tries to draw before it knows its travel area.

#### Acceptance Criteria

1. WHILE the Controller is not in Envelope_Calibrated_State, THE Drawing_Gate SHALL block the start of drawing.
2. THE Envelope_Calibrated_State SHALL require both Home_Set_State and Envelope_Captured_State.
3. WHILE the Controller is in Home_Set_State but not in Envelope_Captured_State, THE Drawing_Gate SHALL block the start of drawing.
4. IF the SPA attempts to begin drawing while the Controller is not in Envelope_Calibrated_State, THEN THE Controller SHALL reject the begin-draw request with a NACK identifying that envelope calibration is required.
5. THE SPA SHALL distinguish Home_Set_State from Envelope_Captured_State in the user interface so that the user can tell which calibration steps remain.

### Requirement 5: No Silent Dangerous Fallback

**User Story:** As a user, I want the machine to refuse to draw rather than fall back to the unsafe scaling, so that an uncalibrated machine never slams the axes.

#### Acceptance Criteria

1. WHILE no valid Step_Envelope exists, THE Controller SHALL keep drawing blocked and SHALL NOT fall back to Gear_Math_Scaling for drawing.
2. WHEN the Controller starts with an absent or empty Step_Envelope in NVM, THE Controller SHALL report a not-calibrated envelope state and SHALL keep the Drawing_Gate engaged.
3. IF the firmware is upgraded or the NVM is reset such that no valid Step_Envelope is present, THEN THE Controller SHALL require Visual_Calibration before drawing and SHALL NOT use Gear_Math_Scaling as a default.

### Requirement 6: Jog Travel Safety Cap

**User Story:** As a user, I want the machine to refuse jogs that would overshoot, so that I cannot slam the axes during calibration.

#### Acceptance Criteria

1. THE Controller SHALL enforce a fixed Jog_Travel_Cap on accumulated jog travel per axis, expressed in motor steps, that is larger than any expected Step_Envelope.
2. WHILE no corner has been captured, THE Controller SHALL enforce the Jog_Travel_Cap so that calibration jogs cannot drive an axis beyond the cap.
3. IF a jog would move an axis beyond the Jog_Travel_Cap, THEN THE Controller SHALL refuse the jog with a NACK identifying the travel-cap limit and SHALL NOT move the axis beyond the cap.
4. THE Jog_Travel_Cap SHALL be a fixed per-session limit that does not depend on a captured Step_Envelope.

### Requirement 7: Envelope Persistence in NVM

**User Story:** As a user, I want my calibration to survive reboots, so that I do not recalibrate after every power cycle.

#### Acceptance Criteria

1. THE PersistedConfig record SHALL include Envelope_X_Steps and Envelope_Y_Steps fields and an envelope-calibrated flag, following the precedent of the existing backlash fields and calibrated flag.
2. WHEN the Controller accepts a valid Step_Envelope, THE Controller SHALL persist Envelope_X_Steps, Envelope_Y_Steps, and the envelope-calibrated flag to NVM.
3. WHEN the Controller restarts with a valid persisted Step_Envelope, THE Controller SHALL restore the Step_Envelope and the Envelope_Captured_State from NVM.
4. THE Controller SHALL bump the PersistedConfig record version, update the affected static_asserts on field offsets and record size, and include the new fields in the record CRC coverage.
5. WHERE a stored PersistedConfig record carries an older record version, THE Controller SHALL treat the Step_Envelope as absent and SHALL require Visual_Calibration.

### Requirement 8: Calibration State in HELLO and STATUS

**User Story:** As a user, I want the interface to show that calibration is complete, so that I know when I can draw.

#### Acceptance Criteria

1. THE HELLO_Frame SHALL carry Envelope_X_Steps, Envelope_Y_Steps, and an envelope-calibrated flag, mirroring how the existing backlash values and calibrated flag are carried.
2. THE STATUS_Frame SHALL carry an envelope-calibrated flag mirroring the existing calibrated flag.
3. WHEN the SPA receives a HELLO_Frame, THE SPA SHALL rehydrate the displayed calibration state from the envelope-calibrated flag and the envelope step values.
4. WHEN the Controller's Envelope_Captured_State changes, THE Controller SHALL reflect the change in subsequent STATUS_Frame and HELLO_Frame reporting.
5. WHILE the Controller is in Envelope_Calibrated_State, THE SPA SHALL indicate to the user that calibration is complete.

### Requirement 9: New Control Message for Envelope Capture

**User Story:** As a developer, I want a defined control message to capture the envelope, so that firmware and the SPA agree on the wire format.

#### Acceptance Criteria

1. THE CTL_Message set SHALL define a Capture_Bottom_Left_Message and a Capture_Top_Right_Message with assigned kind codes that do not collide with the existing control kind codes.
2. WHEN the Controller receives a Capture_Bottom_Left_Message or a Capture_Top_Right_Message of the correct length, THE Controller SHALL respond using the existing ACK or NACK semantics used by the other control messages.
3. IF a Capture_Bottom_Left_Message or a Capture_Top_Right_Message has an incorrect payload length, THEN THE Controller SHALL reject the message with a NACK identifying the length error.
4. THE Capture_Bottom_Left_Message and Capture_Top_Right_Message Wire_Layout SHALL be defined once as a single source of truth shared by the firmware control parser and the SPA encoder.

### Requirement 10: Re-Calibration

**User Story:** As a user, I want to redo the corners at any time, so that I can fix a bad calibration without rebooting.

#### Acceptance Criteria

1. WHEN the user captures the Bottom_Left_Corner again, THE Controller SHALL re-establish home at the current stylus position and SHALL clear the prior Envelope_Captured_State.
2. WHILE the prior Envelope_Captured_State is cleared and the Top_Right_Corner has not been recaptured, THE Drawing_Gate SHALL block the start of drawing.
3. WHEN the user recaptures the Top_Right_Corner after re-establishing home, THE Controller SHALL record a new Step_Envelope that replaces the prior Step_Envelope.
4. WHEN the Controller records a new Step_Envelope during re-calibration, THE Controller SHALL persist the new Step_Envelope to NVM, replacing the prior persisted values.

### Requirement 11: Single Source of Truth for Wire Layout

**User Story:** As a developer, I want the envelope and control layouts defined once, so that firmware and the SPA never diverge.

#### Acceptance Criteria

1. THE Step_Envelope field widths and offsets used in the HELLO_Frame and PersistedConfig SHALL be consistent between the firmware and the SPA.
2. WHEN a change is made to a shared envelope or CTL_Message Wire_Layout, THE change SHALL apply to both the firmware and the SPA so that the layout does not diverge.
3. THE firmware SHALL pin the Step_Envelope field offsets and record size with static_asserts so that an accidental layout change fails the build.

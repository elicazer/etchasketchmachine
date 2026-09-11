# Requirements Document

## Introduction

This document specifies the requirements for a self-drawing Etch-a-Sketch machine. The system uses two NEMA 17 stepper motors (bipolar, 64 oz·in holding torque) driven by A4988 Stepstick drivers on a CNC Shield V3.0 (HiLetgo), connected to an Arduino R4 WiFi. The CNC Shield V3.0 plugs directly into the Arduino R4 WiFi's Uno-compatible header pins and is powered by a user-supplied 12V DC supply sized appropriately for two NEMA 17 stepper motors (a 12V/5A supply is typical). The stepper motors physically manipulate the Etch-a-Sketch's knobs via an 18:36 gear ratio (stepper motor drives the smaller 18-tooth gear meshing with a 36-tooth gear on the Etch-a-Sketch knob), providing 2:1 mechanical advantage for precise knob control. A web interface hosted by the Arduino's built-in WiFi allows users to import images, input text, or create drawings, which are then converted into motor paths and transmitted for physical rendering.

Connectivity is WiFi only. Bluetooth is explicitly NOT supported by this system; all communication between user devices and the Controller occurs over the local WiFi network or the Controller's Access Point fallback.

The Etch-a-Sketch has no pen-up capability: the stylus is always in contact with the drawing surface and all stylus motion produces visible lines. Multi-contour drawings are therefore rendered as a single continuous stroke with visible connector segments between contours (see Requirement 14). The drawing surface is erased manually by the user shaking the device; the system does not perform automatic erase.

## Glossary

- **Controller**: The Arduino R4 WiFi microcontroller running the firmware that receives drawing commands and drives the stepper motors
- **Web_Interface**: The browser-based application that provides image import, text input, and drawing tools, and communicates with the Controller
- **Path_Planner**: The software module within the Web_Interface that converts processed images and text into sequential motor movement commands
- **Image_Processor**: The software module within the Web_Interface that performs edge detection and path extraction on imported images
- **CNC_Shield**: The CNC Shield V3.0 (HiLetgo) that plugs into the Arduino R4 WiFi's Uno-compatible headers and provides socket connections for up to 4 A4988 stepper drivers
- **Motor_Driver**: The A4988 Stepstick stepper motor driver module that translates step/direction signals into motor coil energization sequences
- **X_Motor**: The NEMA 17 stepper motor controlling horizontal movement of the Etch-a-Sketch stylus
- **Y_Motor**: The NEMA 17 stepper motor controlling vertical movement of the Etch-a-Sketch stylus
- **Drawing_Command**: A structured message containing step count, direction, and speed for each axis, sent from the Web_Interface to the Controller
- **G-Code**: An intermediate representation of toolpaths used internally by the Path_Planner to describe linear and arc movements
- **Step_Resolution**: The angular displacement per motor step, which combined with the 18:36 gear ratio yields the effective stylus displacement per step
- **Home_Position**: The bottom-left corner of the drawable area, defined as the canonical origin (0,0) for all drawings
- **Backlash**: The number of motor steps consumed by mechanical slack in the gear train and Etch-a-Sketch knobs after a direction reversal before the stylus actually begins moving in the new direction
- **Connector_Segment**: A straight-line motion segment inserted by the Path_Planner between the end of one polyline and the start of the next, used to join disconnected contours into a single continuous stroke because the Etch-a-Sketch stylus cannot be lifted

## Requirements

### Requirement 1: WiFi Connectivity

**User Story:** As a user, I want the Etch-a-Sketch machine to connect to my local WiFi network, so that I can send drawings from any device on the same network without physical cables.

#### Acceptance Criteria

1. WHEN the Controller is powered on, THE Controller SHALL initiate a WiFi connection attempt to the stored network credentials within 10 seconds of boot
2. WHILE connected to WiFi, THE Controller SHALL host an HTTP server on port 80 that accepts Drawing_Command messages and responds with an acknowledgment within 500 milliseconds of receipt
3. IF the Controller fails to connect to WiFi within 30 seconds, THEN THE Controller SHALL enter Access Point mode and broadcast an SSID containing the prefix "EtchSketch_" for direct connection
4. WHILE in Access Point mode, THE Controller SHALL serve a configuration page allowing the user to enter WiFi credentials (SSID up to 32 characters, password between 8 and 63 characters)
5. WHEN WiFi credentials are submitted with a non-empty SSID and a password of at least 8 characters, THE Controller SHALL store the credentials in non-volatile memory and restart the connection process
6. IF the WiFi connection is lost while the Controller is operating, THEN THE Controller SHALL attempt to reconnect to the stored network for up to 30 seconds, and if reconnection fails, THE Controller SHALL enter Access Point mode
7. WHEN the Controller successfully connects to WiFi, THE Controller SHALL indicate its assigned IP address on the Access Point configuration page and via mDNS using the hostname "etchasketch.local"

### Requirement 2: Web Interface - Image Import

**User Story:** As a user, I want to import images from my device into the web interface, so that the machine can draw pictures I choose.

#### Acceptance Criteria

1. THE Web_Interface SHALL accept image uploads in PNG, JPEG, BMP, and SVG formats
2. WHEN an image is uploaded, THE Web_Interface SHALL display a preview of the image within the drawing canvas area
3. WHEN an image is uploaded, THE Web_Interface SHALL allow the user to scale the image between 10% and 500% of the drawable area dimensions, rotate the image in 1-degree increments from 0 to 359 degrees, and position the image anywhere within the drawable area boundaries
4. THE Web_Interface SHALL limit accepted image file size to 10 MB
5. IF an unsupported file format is uploaded, THEN THE Web_Interface SHALL display an error message listing the supported formats (PNG, JPEG, BMP, SVG)
6. IF an uploaded file exceeds the 10 MB size limit, THEN THE Web_Interface SHALL reject the upload and display an error message indicating the maximum allowed file size
7. IF an uploaded image file cannot be read or is corrupted, THEN THE Web_Interface SHALL display an error message indicating the file could not be processed and prompt the user to select a different file

### Requirement 3: Web Interface - Text Input

**User Story:** As a user, I want to type text and have the machine draw it on the Etch-a-Sketch, so that I can create text-based artwork.

#### Acceptance Criteria

1. WHEN text of 1 to 200 characters is entered, THE Web_Interface SHALL render the text using a single-line stroke font that produces a continuous toolpath without pen lifts within each character
2. THE Web_Interface SHALL provide at least 5 selectable stroke fonts composed of single-line strokes for continuous-path drawing
3. WHEN text is entered, THE Web_Interface SHALL allow the user to adjust font size between 5mm and 100mm character height, letter spacing between 0% and 200% of character width, and position within the drawable area
4. WHEN text is entered or any text parameter is changed, THE Web_Interface SHALL display an updated preview of the text as it will appear when drawn
5. WHEN text contains characters not available in the selected font, THE Web_Interface SHALL highlight the unsupported characters and suggest an alternative font that supports them
6. IF the text input is empty or contains only whitespace, THEN THE Web_Interface SHALL disable the draw action and display a message indicating that text input is required

### Requirement 4: Image Processing and Edge Detection

**User Story:** As a user, I want uploaded images to be automatically converted into drawable line paths, so that the machine can reproduce them as continuous drawings.

#### Acceptance Criteria

1. WHEN a raster image is processed, THE Image_Processor SHALL apply Canny edge detection to extract contour lines from the image
2. WHEN edge detection is complete, THE Image_Processor SHALL allow the user to adjust threshold sensitivity via a slider control with lower and upper threshold values ranging from 0 to 255, and SHALL update the preview within 500 milliseconds of slider adjustment
3. WHEN edges are detected, THE Image_Processor SHALL reduce detected edges to single-pixel-width contours using non-maximum suppression
4. WHEN an SVG image is imported, THE Image_Processor SHALL extract vector paths directly without rasterization
5. IF an imported SVG contains unsupported elements, THEN THE Image_Processor SHALL skip unsupported elements and process all supported path elements, displaying a notification indicating which elements were skipped
6. WHEN contour detection is complete, THE Image_Processor SHALL convert all detected contours into ordered polyline sequences where each polyline consists of connected pixel coordinates with no gap greater than 1 pixel between consecutive points
7. WHEN multiple disconnected contours exist, THE Image_Processor SHALL optimize traversal order using a nearest-neighbor heuristic to minimize the total length of Connector_Segments inserted by the Path_Planner per Requirement 14 (because the stylus cannot be lifted, all between-contour travel produces visible connector lines)
8. IF edge detection produces no detectable contours from the processed image, THEN THE Image_Processor SHALL display a notification indicating no edges were found and SHALL allow the user to adjust threshold values and retry

### Requirement 5: Path Planning and G-Code Generation

**User Story:** As a user, I want the system to generate efficient motor paths from my drawings, so that the machine draws accurately and quickly.

#### Acceptance Criteria

1. WHEN a drawing is finalized, THE Path_Planner SHALL convert the polyline sequences into G-Code representing linear movements (G1 commands) with X and Y coordinates expressed in steps
2. THE Path_Planner SHALL scale all coordinates to match the physical Etch-a-Sketch drawing area (152mm x 105mm), clamping any out-of-bounds coordinates to the drawable area boundaries
3. THE Path_Planner SHALL calculate step counts for each movement segment using the 18:36 gear ratio and the stepper motor's native 1.8-degree step angle (200 steps per revolution), yielding 400 steps per full knob revolution
4. WHEN generating G-Code, THE Path_Planner SHALL apply line simplification (Ramer-Douglas-Peucker algorithm) with a user-adjustable tolerance between 0.1 and 5.0 steps to reduce unnecessary micro-movements
5. THE Path_Planner SHALL generate trapezoidal acceleration and deceleration ramps for each movement segment, ramping from a minimum speed of 100 steps per second to the configured maximum speed, to prevent stepper motor stalling
6. FOR ALL generated paths, parsing the G-Code then converting back to polylines SHALL produce coordinates equivalent to the original polylines within one step of tolerance (round-trip property)

### Requirement 6: Motor Control Firmware

**User Story:** As a user, I want the stepper motors to execute drawing commands precisely, so that the physical output matches the digital preview.

#### Acceptance Criteria

1. WHEN a Drawing_Command is received, THE Controller SHALL drive the X_Motor and Y_Motor simultaneously to produce coordinated diagonal movements using Bresenham's line algorithm
2. THE Controller SHALL support microstepping at 1/16 step resolution via the A4988 Motor_Driver configuration, yielding 3200 microsteps per motor revolution
3. WHILE executing a Drawing_Command, THE Controller SHALL maintain a maximum step rate of 1000 steps per second to prevent motor stalling at the 18:36 gear ratio load
4. WHEN a sequence of Drawing_Commands is received, THE Controller SHALL buffer up to 32 commands to ensure continuous motion without pauses between segments
5. IF the command buffer is full, THEN THE Controller SHALL signal the Web_Interface to pause transmission until buffer space is available (flow control)
6. WHEN a stop command is received, THE Controller SHALL decelerate both motors to a stop within 50 milliseconds and discard remaining buffered commands
7. IF a Drawing_Command is received with invalid parameters (negative step count, speed exceeding 1000 steps per second, or malformed data), THEN THE Controller SHALL reject the command, send an error response to the Web_Interface, and continue processing the next buffered command
8. WHEN the Controller is powered on and no Drawing_Commands have been received, THE Controller SHALL hold both motors in an idle state with holding torque disabled to prevent overheating

### Requirement 7: Communication Protocol

**User Story:** As a user, I want reliable communication between the web interface and the machine, so that drawings are transmitted without errors or data loss.

#### Acceptance Criteria

1. THE Web_Interface SHALL communicate with the Controller using WebSocket protocol for bidirectional messaging with a maximum one-way message delivery latency of 500 milliseconds under normal operating conditions
2. WHEN a Drawing_Command is sent, THE Web_Interface SHALL include a sequence number and checksum for error detection
3. IF the Controller receives a Drawing_Command with an invalid checksum, THEN THE Controller SHALL request retransmission of that specific command by sequence number, up to a maximum of 3 retransmission attempts
4. WHILE a drawing is in progress, THE Controller SHALL send progress updates to the Web_Interface at least once per second, including current position and percentage complete
5. IF the WebSocket connection is lost during drawing, THEN THE Controller SHALL pause execution and retain the current position, resuming when the connection is re-established within 60 seconds
6. IF the WebSocket connection is not re-established within 60 seconds, THEN THE Controller SHALL abort the drawing, retain the last known position, and report a connection timeout error to the Web_Interface upon next connection
7. IF retransmission of a Drawing_Command fails after 3 attempts, THEN THE Controller SHALL pause drawing execution and send an unrecoverable transmission error indication to the Web_Interface
8. THE Web_Interface SHALL guarantee that serializing a Drawing_Command to the wire format and then deserializing it produces a command with field values equal to the original command (round-trip property)

### Requirement 8: Drawing Canvas and Preview

**User Story:** As a user, I want to see an accurate preview of what will be drawn before sending it to the machine, so that I can make adjustments without wasting time.

#### Acceptance Criteria

1. THE Web_Interface SHALL display a drawing canvas with the same aspect ratio as the physical Etch-a-Sketch drawing area (152mm x 105mm) and a minimum canvas width of 300 CSS pixels
2. WHEN a drawing path is generated, THE Web_Interface SHALL render an animated preview showing the drawing order and direction at a user-adjustable playback speed between 0.25x and 4x real-time, visually distinguishing original drawn segments from Connector_Segments (per Requirement 14) using a distinct line style such as dashed strokes or a lighter color
3. WHEN a drawing path is generated or any drawing parameter is modified, THE Web_Interface SHALL display the estimated drawing time in minutes and seconds, calculated from the configured motor speed (steps per second) and total path length (in steps)
4. WHEN the user modifies any parameter (threshold, scale, position), THE Web_Interface SHALL update the preview within 500 milliseconds
5. THE Web_Interface SHALL allow the user to manually draw paths on the canvas using mouse or touch input as an additional input method
6. IF a generated or user-drawn path contains coordinates outside the drawable area (152mm x 105mm), THEN THE Web_Interface SHALL visually highlight the out-of-bounds segments and display a warning message indicating the path exceeds the physical drawing boundaries

### Requirement 9: Drawing Execution Control

**User Story:** As a user, I want to control the drawing process in real-time, so that I can pause, resume, or cancel drawings as needed.

#### Acceptance Criteria

1. WHILE a drawing is in progress, THE Web_Interface SHALL display a pause button
2. WHEN the pause button is activated, THE Controller SHALL pause motor movement within 50 milliseconds
3. WHILE a drawing is paused, THE Web_Interface SHALL display a resume button
4. WHEN the resume button is activated, THE Controller SHALL continue drawing from the exact position where it was paused
5. WHEN a cancel command is issued, THE Controller SHALL stop both motors and clear the command buffer within 100 milliseconds
6. WHEN a drawing is cancelled, THE Web_Interface SHALL indicate that the drawing has been stopped and return to the ready state
7. WHILE a drawing is in progress, THE Web_Interface SHALL display a speed adjustment slider allowing real-time modification of motor speed between 25% and 100% of maximum in 1% increments
8. WHEN drawing speed is adjusted during execution, THE Controller SHALL apply the new speed starting from the next movement segment without interrupting the current segment

### Requirement 10: Calibration and Homing

**User Story:** As a user, I want the machine to automatically return to its home position after each drawing and to remember its position across power cycles, so that I only need to manually jog to the corner during initial setup or after an unclean shutdown.

#### Acceptance Criteria

1. THE Web_Interface SHALL designate the bottom-left corner of the drawable area as the Home_Position and the canonical default origin (0,0) for all drawings
2. WHEN the Controller is powered on for the first time after firmware installation, THE Controller SHALL mark the stylus position as uncalibrated and require manual homing before any drawing can begin
3. WHEN the stylus position is uncalibrated, THE Web_Interface SHALL provide manual jog controls allowing the user to move each motor independently in both positive and negative directions in single full-step increments (1.8 degrees motor rotation per step)
4. WHEN the user has manually jogged the stylus to the bottom-left corner of the drawable area, THE Web_Interface SHALL allow the user to declare the current position as the Home_Position
5. WHEN the user declares the Home_Position, THE Controller SHALL set the logical stylus position to (0,0) and store the position in non-volatile memory along with a "position calibrated" flag
6. WHEN any drawing or movement command is executed, THE Controller SHALL track the current logical stylus position and persist it to non-volatile memory
7. WHEN a drawing completes successfully, THE Controller SHALL automatically issue motion commands to return the stylus from its current position back to the Home_Position before going idle, treating the return-to-home segment as a Connector_Segment per Requirement 14 (a visible line will be drawn on the physical Etch-a-Sketch during this travel)
8. WHEN the Web_Interface prompts the user to manually shake the Etch-a-Sketch device to erase the drawing surface, THE Controller SHALL retain its tracked position because shaking the Etch-a-Sketch does not move the knobs or the stylus
9. WHILE a drawing is in progress or the system is in calibration mode, THE Web_Interface SHALL display the current estimated stylus position in steps relative to the Home_Position, updated at least once per second
10. WHEN a drawing is initiated, THE Path_Planner SHALL offset all coordinates relative to the Home_Position
11. IF a drawing is initiated and the Controller's "position calibrated" flag is not set, THEN THE Web_Interface SHALL prompt the user to jog to the bottom-left corner and declare the Home_Position before proceeding, and SHALL NOT transmit Drawing_Commands until the Home_Position is confirmed
12. IF the Controller detects an unclean shutdown (power loss during drawing) on next boot, THEN THE Controller SHALL clear the "position calibrated" flag, retain the last known position estimate as a hint, and require the user to verify or re-declare the Home_Position before allowing new drawings
13. THE Web_Interface SHALL provide a manual "re-home" control that, when activated, clears the "position calibrated" flag and enters the manual jog calibration flow
14. THE Controller SHALL establish the Home_Position only via the user-initiated manual jog and home-declaration sequence described in this requirement, treating limit switches and travel-end mechanical stops as unused for homing purposes

### Requirement 11: Freehand Drawing Input

**User Story:** As a user, I want to draw freehand on the web interface and have the machine replicate my drawing, so that I can create custom artwork without importing files.

#### Acceptance Criteria

1. THE Web_Interface SHALL provide a freehand drawing tool that captures mouse or touch input as polyline coordinates, where a stroke is defined as the sequence of points captured between a pointer-down event and the corresponding pointer-up event
2. WHILE freehand drawing is active (pointer is down), THE Web_Interface SHALL sample input coordinates at a minimum rate of 60 points per second
3. WHEN a freehand stroke is completed (pointer-up event), THE Path_Planner SHALL apply 2 iterations of Chaikin's corner-cutting algorithm to reduce jitter, such that no output point deviates more than 5 pixels from the nearest point on the original polyline
4. THE Web_Interface SHALL provide an undo function that removes the last drawn stroke, supporting at least 50 consecutive undo operations
5. THE Web_Interface SHALL provide a clear function that removes all drawn content from the canvas
6. IF a completed stroke contains fewer than 3 captured points, THEN THE Web_Interface SHALL discard the stroke and not add it to the canvas
7. WHEN the user activates a "send to machine" action, THE Path_Planner SHALL treat all strokes currently on the canvas as the completed freehand drawing and generate Drawing_Commands for the full composition

### Requirement 12: System Status and Diagnostics

**User Story:** As a user, I want to see the machine's status and diagnose issues, so that I can troubleshoot problems without specialized tools.

#### Acceptance Criteria

1. THE Web_Interface SHALL display the Controller's connection status (connected, disconnected, or connecting) with a color-coded indicator, updating within 2 seconds of a status change
2. WHILE connected, THE Web_Interface SHALL display the Controller's WiFi signal strength (RSSI) in dBm, updated every 5 seconds
3. WHEN a motor stall is detected (position error exceeding 4 or more missed steps within a single movement segment), THE Controller SHALL pause execution and notify the Web_Interface with a stall error message indicating which motor (X_Motor or Y_Motor) stalled
4. THE Web_Interface SHALL provide a motor test function that moves each motor 200 steps forward and 200 steps backward, and SHALL report the test result for each motor as pass (completed without stall or fault) or fail (stall detected or fault pin active)
5. IF the Controller detects the A4988 Motor_Driver fault pin is active, THEN THE Controller SHALL disable motor outputs within 10 milliseconds and report the fault condition to the Web_Interface indicating which Motor_Driver triggered the fault
6. IF a Motor_Driver fault condition has been reported, THEN THE Web_Interface SHALL display a fault reset control that, when activated, re-enables motor outputs and clears the fault indicator

### Requirement 13: Backlash Compensation

**User Story:** As a user, I want the machine to compensate for mechanical backlash in the gear train and Etch-a-Sketch knobs, so that direction reversals don't lose steps and drawings stay accurate.

#### Acceptance Criteria

1. THE Web_Interface SHALL provide a backlash calibration wizard that guides the user to measure Backlash for the X axis and the Y axis independently, producing one Backlash value per axis
2. WHEN the user starts the backlash calibration wizard for an axis, THE Web_Interface SHALL command the Controller to jog that axis a known distance forward in the positive direction
3. WHEN the forward jog completes, THE Web_Interface SHALL reverse the commanded direction and command the Controller to jog the axis one step at a time, prompting the user after each step to confirm whether the stylus has visibly started moving in the new direction
4. WHEN the user confirms that the stylus has started moving in the new direction, THE Web_Interface SHALL record the number of steps issued since the direction reversal as the Backlash value for that axis
5. WHEN a Backlash value is recorded for an axis, THE Controller SHALL store the Backlash value in non-volatile memory persisted across power cycles
6. WHEN any commanded movement reverses direction on an axis relative to that axis's previous direction of motion, THE Controller SHALL prepend the configured Backlash compensation steps for that axis to the movement before issuing the actual commanded steps
7. WHILE issuing Backlash compensation steps, THE Controller SHALL NOT count those steps toward the logical stylus position tracked relative to the Home_Position
8. THE Web_Interface SHALL display the currently stored Backlash values for the X axis and the Y axis and SHALL allow the user to manually edit each value to any non-negative integer between 0 and 200 steps
9. THE Web_Interface SHALL allow the user to re-run the backlash calibration wizard for either axis at any time when no drawing is in progress
10. WHEN the Controller has no stored Backlash value for an axis, THE Controller SHALL use a default Backlash value of 0 steps for that axis
11. IF a drawing is initiated while either axis has a Backlash value of 0 steps and no calibration has been performed in the current installation, THEN THE Web_Interface SHALL display a warning indicating that uncalibrated drawings may exhibit visible discontinuities at direction reversals, and SHALL allow the user to proceed or cancel

### Requirement 14: Continuous Stroke Path Construction

**User Story:** As a user, I understand the Etch-a-Sketch cannot lift its stylus, so I want the system to convert multi-contour drawings into a single continuous stroke even if that means visible connector lines.

#### Acceptance Criteria

1. WHEN multiple disconnected polylines exist after image processing, text rendering, or freehand input, THE Path_Planner SHALL connect the polylines into a single continuous stroke by inserting a Connector_Segment as a straight-line motion from the end of one polyline to the start of the next
2. THE Path_Planner SHALL determine the order in which polylines are traversed using the same nearest-neighbor heuristic specified in Requirement 4, acceptance criterion 7
3. THE Path_Planner SHALL minimize the total length of all Connector_Segments using the nearest-neighbor heuristic
4. WHEN a drawing path containing Connector_Segments is rendered in the preview, THE Web_Interface SHALL display Connector_Segments using a distinct visual style such as dashed strokes or a lighter color, so the user can see where unavoidable extra lines will appear on the physical drawing
5. WHEN a drawing path is generated, THE Web_Interface SHALL display the connector-inclusive total path length in steps and the estimated drawing time in minutes and seconds, calculated from the configured motor speed and the sum of polyline length and Connector_Segment length
6. WHEN Drawing_Commands are generated for the full composition, THE Path_Planner SHALL emit motion commands for Connector_Segments using the same G-Code linear movement representation as for original polyline segments, because the stylus produces a visible line during all motion
7. WHEN the Controller automatically returns to the Home_Position at the end of a drawing per Requirement 10, THE Path_Planner or Controller SHALL render that travel as a Connector_Segment, producing a visible line on the physical Etch-a-Sketch (because the stylus cannot be lifted)

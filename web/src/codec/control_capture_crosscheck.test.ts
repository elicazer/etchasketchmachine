import { describe, it, expect } from 'vitest';
import { encodeControl, CtlKind } from './control';

/**
 * Cross-language single-source-of-truth fixture for the envelope-capture CTL
 * layout (Task 11.2).
 *
 * Feature: visual-corner-calibration, Property 7
 *
 * Property 7: New CTL kinds validate length and round-trip
 * (cross-language encode side).
 *
 * This pins the capture CTL wire layout as a SINGLE SOURCE OF TRUTH shared with
 * the firmware control parser. Here we assert the TS encoder emits exactly the
 * single kind bytes 0x0E / 0x0F. The matching firmware assertion — that
 * parseControl accepts exactly those single bytes to the corresponding
 * ControlKind — lives in:
 *
 *     firmware/tests/test_capture_ctl_props/test_capture_ctl_props.cpp
 *
 * (see the "Property 7 (concrete): capture kinds use codes 0x0E and 0x0F" case,
 * which REQUIREs parseControl({0x0E}) -> Ok + CAPTURE_BOTTOM_LEFT and
 * parseControl({0x0F}) -> Ok + CAPTURE_TOP_RIGHT).
 *
 * The shared contract is: captureBottomLeft ⇔ 0x0E, captureTopRight ⇔ 0x0F,
 * each a parameterless single-byte payload (the Controller measures its own
 * steps, so no payload is carried). If either side changes a code or adds a
 * payload, these paired assertions diverge and a build fails — the layout can
 * never silently drift apart.
 *
 * Validates: Requirements 9.1, 9.4, 11.2.
 */
describe('CTL capture cross-check (firmware ↔ web shared 0x0E/0x0F contract)', () => {
    it('encodeControl(captureBottomLeft) -> single byte 0x0E', () => {
        // Shared contract: firmware parseControl({0x0E}) -> CAPTURE_BOTTOM_LEFT.
        expect(encodeControl({ kind: 'captureBottomLeft' })).toEqual(
            Uint8Array.of(0x0e),
        );
    });

    it('encodeControl(captureTopRight) -> single byte 0x0F', () => {
        // Shared contract: firmware parseControl({0x0F}) -> CAPTURE_TOP_RIGHT.
        expect(encodeControl({ kind: 'captureTopRight' })).toEqual(
            Uint8Array.of(0x0f),
        );
    });

    it('the CtlKind codes match the shared firmware ControlKind codes', () => {
        expect(CtlKind.CAPTURE_BOTTOM_LEFT).toBe(0x0e);
        expect(CtlKind.CAPTURE_TOP_RIGHT).toBe(0x0f);
    });
});

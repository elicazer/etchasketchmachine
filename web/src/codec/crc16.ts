/**
 * CRC-16/CCITT-FALSE implementation.
 *
 * Parameters (per Design §4.3, used for the Drawing_Command wire protocol):
 *   - polynomial: 0x1021
 *   - initial value: 0xFFFF
 *   - no input reflection
 *   - no output reflection
 *   - final XOR: 0x0000 (i.e., none)
 *
 * The same algorithm is implemented bit-for-bit in the firmware
 * (`firmware/src/protocol/crc16.cpp`) so checksums computed by the
 * browser SPA match those validated on the controller.
 *
 * This bit-serial implementation is intentionally table-free: command
 * payloads are at most 16 bytes, so the loop overhead is negligible
 * and the function adds no static data to the gzipped SPA budget.
 *
 * @see Requirements 7.2
 * @see Design §4.3
 */
export function crc16ccitt(data: Uint8Array): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 8;
        for (let bit = 0; bit < 8; bit++) {
            if ((crc & 0x8000) !== 0) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc = crc << 1;
            }
            crc &= 0xffff;
        }
    }
    return crc;
}

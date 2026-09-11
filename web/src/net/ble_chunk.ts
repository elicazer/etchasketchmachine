/**
 * `ble_chunk` — pure MTU fragmentation/reassembly for the BLE transport.
 *
 * BLE notifications/writes carry at most one negotiated-MTU payload, so a
 * complete `Frame_Envelope` must be split into ordered chunks on send and
 * reassembled byte-for-byte on receive (Design §3.6, §4.3). This module owns
 * **only** that chunking; it has no Web Bluetooth dependency and never sees
 * the protocol layer, so it is trivially unit/property testable and shares the
 * exact wire format with the firmware `ble_chunk` core.
 *
 * Chunk wire format (Design §4.3):
 *
 * ```
 * Offset  Size  Field  Notes
 *   0      1    hdr    bits[7:4] = total_chunks (1..15)
 *                      bits[3:0] = chunk_index  (0..total-1)
 *   1      N    body   slice of the Frame_Envelope bytes
 * ```
 *
 * The reassembled concatenation of bodies in index order equals the original
 * `Frame_Envelope`. The header carries no chunk metadata past reassembly: the
 * bytes handed back contain only the frame (Req 5.3).
 *
 * A 4/4-bit split supports up to 15 chunks per frame. Frames requiring more
 * than 15 chunks are unrepresentable; `fragment` rejects them and the
 * reassembler treats `total > 15` as unrecoverable (Req 5.5). The protocol
 * never emits frames that large.
 *
 * @see Design §3.6, §4.3
 * @see Requirements 5.2, 5.3, 5.5
 */

/** Maximum number of chunks a single frame may be split into (4-bit field). */
export const MAX_CHUNKS = 15;

/** Discriminated reasons the reassembler rejects a chunk sequence. */
export type ChunkErrorKind =
    | 'totalTooLarge' // header total_chunks > MAX_CHUNKS (or 0)
    | 'inconsistentTotal' // a chunk's total differs from the in-flight frame
    | 'duplicateIndex' // an index already received for the in-flight frame
    | 'indexOutOfRange' // chunk_index >= total
    | 'incompleteFrame'; // a new frame started before the prior one completed

/** Typed error describing an unrecoverable reassembly failure (Req 5.5). */
export class ChunkError extends Error {
    public readonly kind: ChunkErrorKind;

    constructor(kind: ChunkErrorKind, message: string) {
        super(message);
        this.name = 'ChunkError';
        this.kind = kind;
    }
}

/** `fragment` rejects inputs it cannot represent in the 4/4-bit header. */
export type FragmentErrorKind = 'emptyBody' | 'totalTooLarge';

/** Typed error thrown by {@link fragment}. */
export class FragmentError extends Error {
    public readonly kind: FragmentErrorKind;

    constructor(kind: FragmentErrorKind, message: string) {
        super(message);
        this.name = 'FragmentError';
        this.kind = kind;
    }
}

/** Byte length of the chunk micro-header preceding every body. */
const CHUNK_HEADER_BYTES = 1;

/**
 * Split a complete `Frame_Envelope` into ordered BLE chunks.
 *
 * Produces `ceil(frame.length / body)` chunks, each carrying a 1-byte
 * `(total, index)` header followed by up to `body` frame bytes in order. A
 * zero-length frame still yields one (empty-body) chunk so the reassembler
 * can reproduce it exactly.
 *
 * @param frame the exact `Frame_Envelope` bytes to transmit
 * @param body  maximum body bytes per chunk (the negotiated MTU payload),
 *              `>= 1`
 * @throws {FragmentError} `emptyBody` if `body < 1`; `totalTooLarge` if the
 *         frame would require more than {@link MAX_CHUNKS} chunks
 */
export function fragment(frame: Uint8Array, body: number): Uint8Array[] {
    if (!Number.isInteger(body) || body < 1) {
        throw new FragmentError(
            'emptyBody',
            `fragment: body must be an integer >= 1 (got ${body})`,
        );
    }

    // ceil(len/body), but at least one chunk so an empty frame round-trips.
    const total = frame.length === 0 ? 1 : Math.ceil(frame.length / body);
    if (total > MAX_CHUNKS) {
        throw new FragmentError(
            'totalTooLarge',
            `fragment: frame of ${frame.length} bytes needs ${total} chunks, exceeds ${MAX_CHUNKS}`,
        );
    }

    const chunks: Uint8Array[] = [];
    for (let index = 0; index < total; index++) {
        const start = index * body;
        const end = Math.min(start + body, frame.length);
        const slice = frame.subarray(start, end);
        const chunk = new Uint8Array(CHUNK_HEADER_BYTES + slice.length);
        chunk[0] = ((total & 0x0f) << 4) | (index & 0x0f);
        chunk.set(slice, CHUNK_HEADER_BYTES);
        chunks.push(chunk);
    }
    return chunks;
}

/**
 * Stateful reassembler that turns ordered/unordered BLE chunks back into exact
 * `Frame_Envelope` byte sequences.
 *
 * Feed each received chunk to {@link push}. When the final outstanding index
 * for the in-flight frame arrives, `push` returns the reassembled frame and
 * resets for the next frame; otherwise it returns `null`. On any unrecoverable
 * condition (Req 5.5) `push` throws a {@link ChunkError} and the partial frame
 * is discarded so the caller can signal a transmit error and let the SPA
 * retransmit.
 */
export class Reassembler {
    /** Total chunks expected for the in-flight frame, or 0 when idle. */
    private total = 0;

    /** Received bodies indexed by chunk_index; holes are `undefined`. */
    private bodies: (Uint8Array | undefined)[] = [];

    /** Count of distinct indices received for the in-flight frame. */
    private received = 0;

    /**
     * Ingest one chunk. Returns the completed `Frame_Envelope` when the final
     * missing index arrives, otherwise `null`.
     *
     * @throws {ChunkError} on `total > 15`/0, inconsistent total, duplicate
     *         index, index `>= total`, or a new frame starting before the
     *         current one completes.
     */
    push(chunk: Uint8Array): Uint8Array | null {
        if (chunk.length < CHUNK_HEADER_BYTES) {
            this.reset();
            throw new ChunkError(
                'totalTooLarge',
                'reassemble: chunk missing 1-byte header',
            );
        }

        const hdr = chunk[0];
        const total = (hdr >> 4) & 0x0f;
        const index = hdr & 0x0f;
        const bodyBytes = chunk.subarray(CHUNK_HEADER_BYTES);

        // total is 1..15; a 0 total is unrepresentable. (total > 15 cannot be
        // encoded in 4 bits, but guard defensively for forward compatibility.)
        if (total < 1 || total > MAX_CHUNKS) {
            this.reset();
            throw new ChunkError(
                'totalTooLarge',
                `reassemble: invalid total_chunks ${total} (must be 1..${MAX_CHUNKS})`,
            );
        }
        if (index >= total) {
            this.reset();
            throw new ChunkError(
                'indexOutOfRange',
                `reassemble: index ${index} >= total ${total}`,
            );
        }

        if (this.total === 0) {
            // Begin a new in-flight frame.
            this.total = total;
            this.bodies = new Array<Uint8Array | undefined>(total);
            this.received = 0;
        } else if (total !== this.total) {
            // A chunk whose total disagrees with the in-flight frame: either a
            // corrupted/inconsistent total within one frame, or a new frame
            // starting before the prior one completed. Both are unrecoverable.
            const expected = this.total;
            const hadProgress = this.received > 0;
            this.reset();
            throw new ChunkError(
                hadProgress ? 'incompleteFrame' : 'inconsistentTotal',
                `reassemble: total ${total} differs from in-flight total ${expected}`,
            );
        }

        if (this.bodies[index] !== undefined) {
            this.reset();
            throw new ChunkError(
                'duplicateIndex',
                `reassemble: duplicate chunk index ${index}`,
            );
        }

        this.bodies[index] = bodyBytes;
        this.received++;

        if (this.received < this.total) return null;
        return this.complete();
    }

    /** Whether a partial frame is currently buffered. */
    inFlight(): boolean {
        return this.total !== 0;
    }

    /** Discard any in-flight partial frame and return to the idle state. */
    reset(): void {
        this.total = 0;
        this.bodies = [];
        this.received = 0;
    }

    /** Concatenate buffered bodies in index order and reset for the next frame. */
    private complete(): Uint8Array {
        let length = 0;
        for (const body of this.bodies) length += body!.length;
        const frame = new Uint8Array(length);
        let offset = 0;
        for (const body of this.bodies) {
            frame.set(body!, offset);
            offset += body!.length;
        }
        this.reset();
        return frame;
    }
}

/**
 * Convenience one-shot reassembly used by tests and the round-trip property:
 * feed every chunk to a fresh {@link Reassembler} and return the completed
 * frame. The terminal chunk must complete the frame, otherwise this throws.
 *
 * @throws {ChunkError} on any malformed sequence (Req 5.5)
 * @throws {ChunkError} `incompleteFrame` if the chunks never complete a frame
 */
export function reassemble(chunks: Iterable<Uint8Array>): Uint8Array {
    const r = new Reassembler();
    let frame: Uint8Array | null = null;
    for (const chunk of chunks) {
        frame = r.push(chunk);
    }
    if (frame === null) {
        r.reset();
        throw new ChunkError(
            'incompleteFrame',
            'reassemble: chunk sequence did not complete a frame',
        );
    }
    return frame;
}

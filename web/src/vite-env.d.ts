/// <reference types="vite/client" />

/**
 * Typed Vite env constants for the SPA.
 *
 * `VITE_ESK_TRANSPORT` is the single build-time transport-selection point
 * consumed by `src/app/config.ts` (Design §3.5, Req 4.4). Vite exposes any
 * `VITE_`-prefixed env var on `import.meta.env` at build time, so a build run
 * with `VITE_ESK_TRANSPORT=websocket` produces a WiFi/WebSocket image while the
 * default (unset) resolves to BLE in `config.ts`.
 *
 * Declared as the optional union so consumers handle the unset case explicitly
 * and `config.ts` can default it to `'ble'`.
 *
 * @see Design §3.5, §4
 * @see Requirements 4.4
 */
interface ImportMetaEnv {
    /**
     * Browser transport selected at build time: `'ble'` (default) or
     * `'websocket'`. Unset means BLE — see `TRANSPORT` in `src/app/config.ts`.
     */
    readonly VITE_ESK_TRANSPORT?: 'ble' | 'websocket';
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

/**
 * Force-inlined asset imports (Vite `?inline` query) resolve to a base64
 * `data:` URL string, regardless of `build.assetsInlineLimit`. Used for the
 * Etch-a-Sketch frame photo so the single-file build embeds it directly in
 * `index.html` (Design §10.2) rather than emitting a separate asset.
 */
declare module '*.webp?inline' {
    const src: string;
    export default src;
}

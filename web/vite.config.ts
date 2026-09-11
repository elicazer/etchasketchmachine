import { defineConfig, loadEnv, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Hard size budget for the always-resident SPA. Design §10.2: build fails if exceeded.
const SIZE_BUDGET_BYTES = 120 * 1024;

/**
 * Gzip every file in dist/, write the gzipped tree to dist.gz/, and enforce the
 * 120 KB budget on the primary index.html.gz blob (the one consumed by the
 * firmware build per Design §10.2).
 */
function gzipAndBudget(): Plugin {
    return {
        name: 'esk-gzip-and-budget',
        apply: 'build',
        closeBundle() {
            const distDir = resolve(__dirname, 'dist');
            const gzDir = resolve(__dirname, 'dist.gz');
            mkdirSync(gzDir, { recursive: true });

            const walk = (dir: string): string[] => {
                const out: string[] = [];
                for (const name of readdirSync(dir)) {
                    const full = join(dir, name);
                    if (statSync(full).isDirectory()) {
                        out.push(...walk(full));
                    } else {
                        out.push(full);
                    }
                }
                return out;
            };

            const files = walk(distDir);
            let primaryGzPath: string | null = null;
            let primaryGzSize = 0;

            for (const file of files) {
                const rel = file.slice(distDir.length + 1);
                const data = readFileSync(file);
                const gz = gzipSync(data, { level: zlibConstants.Z_BEST_COMPRESSION });
                const outPath = join(gzDir, rel + '.gz');
                mkdirSync(resolve(outPath, '..'), { recursive: true });
                writeFileSync(outPath, gz);
                if (rel === 'index.html') {
                    primaryGzPath = outPath;
                    primaryGzSize = gz.length;
                }
            }

            if (!primaryGzPath) {
                throw new Error('[esk-gzip-and-budget] index.html not found in dist/');
            }

            const kib = (n: number) => `${(n / 1024).toFixed(2)} KiB`;
            this.info(`gzipped index.html: ${kib(primaryGzSize)} (budget ${kib(SIZE_BUDGET_BYTES)})`);
            if (primaryGzSize > SIZE_BUDGET_BYTES) {
                this.error(
                    `SPA bundle exceeds 120 KB gzipped budget: ${kib(primaryGzSize)} > ${kib(SIZE_BUDGET_BYTES)}`,
                );
            }
        },
    };
}

export default defineConfig(({ mode }) => {
    // Single config point (Design §3.5, Req 4.4): resolve the browser transport
    // at build time. Vite exposes `VITE_`-prefixed vars on `import.meta.env`,
    // so `config.ts` reads `import.meta.env.VITE_ESK_TRANSPORT`. We resolve it
    // here too so the default is deterministic and the value is validated
    // before the bundle is produced — an unset value means BLE (the primary
    // transport), and only `ble`/`websocket` are accepted.
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    const transport = env.VITE_ESK_TRANSPORT ?? 'ble';
    if (transport !== 'ble' && transport !== 'websocket') {
        throw new Error(
            `[esk] Invalid VITE_ESK_TRANSPORT="${transport}". ` +
            `Expected 'ble' or 'websocket' (unset defaults to 'ble').`,
        );
    }

    return {
        plugins: [preact(), viteSingleFile(), gzipAndBudget()],
        // Pin the resolved transport so the single config point resolves
        // deterministically at build time even when the env var is unset.
        define: {
            'import.meta.env.VITE_ESK_TRANSPORT': JSON.stringify(transport),
        },
        build: {
            target: 'es2022',
            // Inline all assets <= 8 KB per Design §10.2. Larger assets are inlined too
            // by viteSingleFile, which emits a single index.html.
            assetsInlineLimit: 8 * 1024,
            cssCodeSplit: false,
            sourcemap: false,
            reportCompressedSize: true,
            rollupOptions: {
                // Single-file output handled by viteSingleFile; no manual chunks.
                output: { inlineDynamicImports: false },
            },
        },
        server: {
            host: '0.0.0.0',
            port: 5173,
        },
    };
});

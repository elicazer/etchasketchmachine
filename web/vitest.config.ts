import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
    plugins: [preact()],
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx', 'tests/unit/**/*.{test,spec}.ts'],
        exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', 'dist.gz/**'],
        passWithNoTests: true,
        // fast-check default ~100 runs per property is fine; tweak per-test via
        // fc.assert(prop, { numRuns }) when needed.
    },
});

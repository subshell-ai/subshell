/**
 * Fixed host ports for the end-to-end stack.
 *
 * Deliberately not random and deliberately far from the development defaults
 * (3080) so an e2e run cannot collide with a running `turbo watch dev`. The
 * backend serves the built SPA, so this single origin IS the whole app.
 */
export const PORTS = { backend: 3199 } as const;

export const BASE_URL = `http://127.0.0.1:${PORTS.backend}`;

/**
 * Fixed host ports for the end-to-end stack.
 *
 * Deliberately not random and deliberately far from the development defaults
 * (3080) so an e2e run cannot collide with a running `turbo watch dev`. The
 * backend serves the built SPA, so this single origin IS the whole app.
 *
 * `fakeRegistry` is the plugin-registry stand-in (stack.ts's `Bun.serve`
 * child): spec 14 installs from it, and NOTHING in the suite ever dials a
 * real registry — the backend child's `SUBSHELL_PLUGIN_REGISTRY_URL` points
 * here, so even a mistaken install cannot reach the public network.
 */
export const PORTS = { backend: 3199, fakeRegistry: 3198 } as const;

export const BASE_URL = `http://127.0.0.1:${PORTS.backend}`;
export const FAKE_REGISTRY_URL = `http://127.0.0.1:${PORTS.fakeRegistry}`;

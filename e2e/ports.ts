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
 *
 * `onboarding` belongs to spec 15's SECOND backend: the suite shares one
 * database, so the first-run wizard happens exactly once (spec 01) and can
 * never repeat there. A clean-machine claim needs a clean instance, and this
 * port is where spec 15 boots one — its own temp DB, its own data dir, and
 * every agent-CLI override pointed at a file that does not exist.
 */
export const PORTS = { backend: 3199, fakeRegistry: 3198, onboarding: 3200 } as const;

export const BASE_URL = `http://127.0.0.1:${PORTS.backend}`;
export const FAKE_REGISTRY_URL = `http://127.0.0.1:${PORTS.fakeRegistry}`;

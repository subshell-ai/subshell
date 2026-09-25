/**
 * Fixed host ports for the end-to-end stack.
 *
 * Deliberately not random and deliberately far from the development defaults
 * (3080) so an e2e run cannot collide with a running `turbo watch dev`. The
 * backend serves the built SPA, so this single origin IS the whole app.
 *
 * Each port carries an env override (the ONLY reason one exists): two suites
 * running side by side — two worktrees, two agents — otherwise collide on
 * :3199, and the second boot dies on `EADDRINUSE` holding nothing of value.
 * The defaults are the committed values; `E2E_PORT_BACKEND=3211
 * E2E_PORT_FAKE_IDP=3212 …` shifts a whole run to a private band.
 *
 * `fakeRegistry` is the plugin-registry stand-in (stack.ts's `Bun.serve`
 * child): spec 14 installs from it, and NOTHING in the suite ever dials a
 * real registry — the backend child's `SUBSHELL_PLUGIN_REGISTRY_URL` points
 * here, so even a mistaken install cannot reach the public network.
 *
 * `fakeIdp` is the OIDC-issuer stand-in (e2e/fixtures/fake-oidc-server.ts):
 * spec 19 signs in through it, and no spec ever dials a real IdP. It is
 * BROWSER-reachable, not just backend-reachable — the OAuth round trip leaves
 * the page, unlike the registry's server-side traffic.
 *
 * `onboarding` belongs to spec 15's SECOND backend: the suite shares one
 * database, so the first-run wizard happens exactly once (spec 01) and can
 * never repeat there. A clean-machine claim needs a clean instance, and this
 * port is where spec 15 boots one — its own temp DB, its own data dir, and
 * every agent-CLI override pointed at a file that does not exist.
 */
const envPort = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`[e2e] ${name} must be a port number, got "${raw}"`);
  }
  return port;
};

export const PORTS = {
  backend: envPort("E2E_PORT_BACKEND", 3199),
  fakeRegistry: envPort("E2E_PORT_FAKE_REGISTRY", 3198),
  fakeIdp: envPort("E2E_PORT_FAKE_IDP", 3197),
  onboarding: envPort("E2E_PORT_ONBOARDING", 3200),
} as const;

export const BASE_URL = `http://127.0.0.1:${PORTS.backend}`;
export const FAKE_REGISTRY_URL = `http://127.0.0.1:${PORTS.fakeRegistry}`;
export const FAKE_IDP_URL = `http://127.0.0.1:${PORTS.fakeIdp}`;

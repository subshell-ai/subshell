/**
 * This bundle's own identity, reported on every terminal attach (`&build=`)
 * and printed on the server's `ws attach` line.
 *
 * WHY: an installed PWA keeps running the JavaScript it already has across any
 * number of server deploys, and the backend does not log static requests — so
 * "is the client actually running the fix" had no answer, and a 2026-09-04
 * debugging session spent hours on renderer theories that a stale bundle would
 * equally explain. Vite content-hashes every chunk, so the hash in this
 * module's own URL changes exactly when its code changes: a reload shows up in
 * the journal as a DIFFERENT id, and no reload shows up as the same one.
 *
 * Derived from `import.meta.url` rather than a build-time constant so nothing
 * has to be threaded through vite config, and dev builds degrade to `"dev"`
 * instead of lying.
 */

/**
 * Extracts the content hash from a built chunk URL.
 *
 * Vite names chunks `<name>-<hash>.js`, where `<name>` may itself contain
 * dashes (`use-subshell-log-B5IhOdMk.js`), so the hash is the LAST
 * dash-separated segment of the basename. Anything that is not a built asset
 * URL — the dev server's `/src/lib/build-id.ts`, a blob/data URL, an empty
 * string under a bundler that dropped `import.meta` — is reported as `"dev"`.
 *
 * @param moduleUrl - the value of `import.meta.url`
 * @returns the chunk hash, or `"dev"` when the URL is not a hashed asset
 */
export function buildIdFrom(moduleUrl: string): string {
  const file = moduleUrl.split("?")[0]?.split("/").pop() ?? "";
  const base = file.replace(/\.[a-z]+$/i, "");
  const last = base.includes("-") ? (base.split("-").pop() ?? "") : "";
  // A Vite hash is 8 alphanumerics; require that shape so a plain dashed
  // source filename (`build-id`) cannot masquerade as a build.
  return /^[A-Za-z0-9_]{8,}$/.test(last) ? last : "dev";
}

/** This bundle's id — computed once at module load. */
export const BUILD_ID = buildIdFrom(import.meta.url);

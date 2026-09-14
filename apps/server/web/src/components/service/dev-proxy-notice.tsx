import type { JSX } from "react";

/**
 * Says, on the pages that report addresses, that this page is not at the
 * address it is reporting on.
 *
 * **Only in a Vite dev build**, where `import.meta.env.DEV` is true — a
 * production bundle has the whole component constant-folded away, so this
 * costs a released instance nothing and cannot be shown to a user by
 * accident.
 *
 * It exists because the Service page's own numbers are, correctly, about the
 * SERVER: the port it listens on, the base URL it hands out. Under `bun run
 * dev` — or inside Subshell Server with `SUBSHELL_DESKTOP_SPA_URL` set, which
 * is the only way the dashboard hot-reloads at all — this page is served by
 * Vite on a different port and proxies `/api` to that server. So the page
 * says 3080 while the address bar says 5174, and both are right. Told once,
 * that is obvious; discovered while wondering why a port change did nothing,
 * it is half an hour.
 *
 * The second sentence is the part that bites: Vite's proxy target is fixed at
 * startup, so changing the port HERE moves the server out from under the
 * proxy and every later request fails until Vite is restarted.
 */
export function DevProxyNotice(): JSX.Element | null {
  if (!import.meta.env.DEV) return null;
  const here = typeof window === "undefined" ? null : window.location.origin;
  return (
    <p className="rounded-md border border-warning/40 px-3 py-2 text-muted-foreground text-xs">
      <span className="text-warning">Development build.</span> This page is served by Vite
      {here ? ` at ${here}` : ""}, and the addresses below describe the server it proxies to — not this one. Changing
      the port here moves that server out from under the proxy until Vite is restarted.
    </p>
  );
}

/**
 * The pure half of the dialog's entry-points editor (spec §5a), split out by
 * review Minor 5 so `provider-dialog.tsx` stays the form: origin validation
 * and candidate merging here, the list editor in `entry-points-editor.tsx`,
 * and the IdP copy panel in `registration-panel.tsx`.
 */

/**
 * Bare-origin validation for an entry point (spec §5a): http(s) scheme, a host,
 * no path/query/fragment/credentials, wildcards refused — the component-wise
 * trusted-origin rule, minus wildcards, mirrored here so a bad paste is caught
 * at the form. Returns the canonical `URL.origin` spelling or null; the route
 * validates again (the server is the boundary, this is the courtesy).
 */
export function normalizeOriginEntry(raw: string): string | null {
  const s = raw.trim();
  if (!s || /[*?\s]/.test(s) || s.includes("@")) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.pathname !== "" && u.pathname !== "/") return null;
    if (u.search || u.hash) return null;
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * The addresses to OFFER as entry points, best first: this browser's, then
 * `appBaseUrl`, then the trusted-origin list, deduped to canonical origins.
 * The same three sources the Add-node and mobile pickers merge
 * (`lib/install-addresses`), with that helper's loopback DROP undone on
 * purpose: this picker is for the round trips of browsers ON THIS plane, and
 * a fresh instance's only address is loopback (spec §5a). An unparseable
 * entry is dropped rather than rendered, exactly as there.
 */
export function entryOriginCandidates(sources: {
  here: string;
  baseUrl: string | undefined;
  trustedOrigins: string[] | undefined;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    const origin = raw ? normalizeOriginEntry(raw) : null;
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    out.push(origin);
  };
  add(sources.here);
  add(sources.baseUrl);
  for (const origin of sources.trustedOrigins ?? []) add(origin);
  return out;
}

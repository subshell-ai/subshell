/**
 * Validates a post-sign-in `?redirect=` target. The value arrives from a URL,
 * so it must never be able to leave the app: only single-slash absolute paths
 * pass — protocol-relative (`//host`), backslash (`/\host`), C0 control
 * chars/spaces, scheme-ful and relative forms all collapse to null and callers
 * fall back to "/".
 */
export function safeRedirect(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // WHATWG URL parsing (window.location.href) strips tab/LF/CR before
  // resolving, so a decoded "/\t/evil.com" would become "//evil.com" and
  // escape the vetoes above. Reject all C0 controls and spaces outright.
  // Tradeoff: a legitimately space-bearing path collapses to the "/"
  // fallback; route paths in this app are ids/word-paths only.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching C0 controls is the whole point here
  if (/[\x00-\x20]/.test(raw)) return null;
  return raw;
}

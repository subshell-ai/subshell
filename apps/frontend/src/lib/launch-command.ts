/**
 * Rendering of a profile as the shell command fragment it contributes when a
 * session launches.
 */

/**
 * Display-only twin of `shellQuote` in `@internal/harnesses` (the backend and
 * plugins execute with that one; the frontend cannot import it) —
 * `it's` becomes `'it'\''s'`, so the preview is paste-ready in any shell.
 */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The profile's share of a session's launch command:
 * `KEY='value' … <binary> 'flag' 'value' …`.
 *
 * Deliberately only what a *profile* contributes. The real launch additionally
 * wraps this in `env -i` with a curated host environment, mints per-session
 * `SUBSHELL_*` credentials (including the session API key), and lets the harness
 * plugin inject session-runtime args (`--mcp-config`, `--settings`, `--name`)
 * — none of which exist until a session starts, so none are previewed here.
 *
 * Corrupt stored blobs degrade to empty rather than throwing; this is a
 * display surface.
 */
export function profileLaunchCommand(envJson: string | null, flagsJson: string | null, binary: string): string {
  const parts: string[] = [];
  try {
    const env = JSON.parse(envJson ?? "{}") as Record<string, unknown>;
    for (const [key, value] of Object.entries(env)) {
      parts.push(`${key}=${quotePosix(String(value ?? ""))}`);
    }
  } catch {
    // Corrupt env blob — nothing to prefix.
  }
  parts.push(binary);
  try {
    const flags = JSON.parse(flagsJson ?? "[]") as unknown[];
    for (const flag of flags) {
      if (typeof flag === "string" && flag) parts.push(quotePosix(flag));
    }
  } catch {
    // Corrupt flags blob — nothing to append.
  }
  return parts.join(" ");
}

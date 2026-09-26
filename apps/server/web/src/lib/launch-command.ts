/**
 * Rendering of a preset as the shell command fragment it contributes when a
 * subshell launches.
 */
import { shellQuote } from "@/lib/preset-command";

/**
 * The preset's share of a subshell's launch command:
 * `KEY=value … <binary> --flag value …`.
 *
 * Names print as names: env keys and flag tokens are NEVER quoted; the
 * command prints bare, and only ever gains quotes if it could not be
 * spelled bare at a prompt, identically in both renderers. ENV values go through
 * {@link shellQuote} (the one quotifier the editor's command panel shares,
 * so the two renderings of a preset cannot disagree) and carry quotes only
 * where a shell would split or expand them; a flag's CLI-arg value prints
 * verbatim, quotes-included only if the person typed them into the value
 * (operator ruling 2026-09-25). A flag without a value contributes no token
 * at all — not an `''`. (Fixed 2026-09-25: this renderer single-quoted every
 * token, so `claude --dangerously-skip-permissions --effort xhigh` previewed
 * as `claude '--dangerously-skip-permissions' '--effort' '' 'xhigh'`.)
 *
 * Deliberately only what a *preset* contributes. The real launch additionally
 * wraps this in `env -i` with a curated host environment, mints per-subshell
 * `SUBSHELL_*` credentials (including the subshell API key), and lets the harness
 * plugin inject subshell-runtime args (`--mcp-config`, `--settings`, `--name`)
 * — none of which exist until a subshell starts, so none are previewed here.
 *
 * Corrupt stored blobs degrade to empty rather than throwing; this is a
 * display surface.
 */
export function presetLaunchCommand(envJson: string | null, flagsJson: string | null, binary: string): string {
  const parts: string[] = [];
  try {
    const env = JSON.parse(envJson ?? "{}") as Record<string, unknown>;
    for (const [key, value] of Object.entries(env)) {
      parts.push(`${key}=${shellQuote(String(value ?? ""))}`);
    }
  } catch {
    // Corrupt env blob — nothing to prefix.
  }
  parts.push(shellQuote(binary));
  try {
    const flags = JSON.parse(flagsJson ?? "[]") as unknown[];
    for (const flag of flags) {
      if (typeof flag !== "string" || flag === "") continue;
      // Every stored token prints VERBATIM (operator ruling 2026-09-25),
      // flag and CLI-arg value alike: quotes in a flag argument are data
      // the person typed, never quoting added here.
      parts.push(flag);
    }
  } catch {
    // Corrupt flags blob — nothing to append.
  }
  return parts.join(" ");
}

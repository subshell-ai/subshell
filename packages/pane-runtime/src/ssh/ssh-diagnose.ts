import type { SshErrorCode } from "@internal/subshell-protocol";

/**
 * Honest classification of ssh's failure output.
 *
 * The connection probe and an ambiguous exit 255 are the two places a
 * failure must be NAMED (SSH-SUPPORT.md §3: "unknown must not masquerade as
 * failed or successful", and a failed test that names no code is refused by
 * the wire validator). Both read the same stderr signals, so both consult
 * ONE classifier here rather than each keeping a regex pile.
 *
 * These matches read OpenSSH's own diagnostics (ssh/sshconnect2.c,
 * readconf.c wording) across the versions the feature supports; a
 * classification miss degrades to `null` / `connection_failed`, never to a
 * WRONG name: `connection_failed` is the frozen code that "must never be
 * dressed up as a diagnosis".
 */

/** Case-insensitive patterns naming OpenSSH's own transport/setup failures on stderr. */
const TRANSPORT_FAILURE_RES: readonly RegExp[] = [
  /connection (closed|refused|reset|timed out)/i,
  /connection established but /i,
  /broken pipe/i,
  /network is unreachable/i,
  /no route to host/i,
  /operation timed out/i,
  /could not resolve hostname/i,
  /name or service not known/i,
  /unable to negotiate/i,
  /no matching (host|key|cipher|mac) type/i,
  /host key verification failed/i,
  /man-in-the-middle attack/i,
  /REMOTE HOST IDENTIFICATION HAS CHANGED/i,
  /too many authentication failures/i,
  /permission denied \(/i,
  /no supported authentication methods/i,
  /client_loop: send disconnect/i,
  /mux_client_request/i,
  /proxy command exited/i,
  /connection to [^ ]+ port \d+ (closed|timed out)/i,
];

/** True when stderr carries a signal that ssh's TRANSPORT (or its setup) failed — the corroborating fact that reads a 255 as ssh's own, not the remote program's. */
export function sshTransportFailure(stderr: string): boolean {
  return TRANSPORT_FAILURE_RES.some((re) => re.test(stderr));
}

/**
 * Best-effort named code for a failed connect/setup, from the child's stderr.
 * Returns null when nothing more specific than "it failed" is visible; the
 * caller then answers the frozen `connection_failed`.
 *
 * Order matters: a changed-key refusal also contains "verification failed",
 * so the more specific test runs first.
 *
 * @param stderr - the ssh child's captured stderr (may be empty)
 */
export function classifySshFailure(stderr: string): SshErrorCode | null {
  const s = stderr;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return "host_key_changed";
  if (/revoked/i.test(s)) return "host_key_revoked";
  if (/host key verification failed/i.test(s)) return "host_key_unknown";
  if (/password|keyboard-interactive|native keyboard-interactive/i.test(s)) return "auth_mode_unsupported";
  if (
    /permission denied|no supported authentication methods|too many authentication failures|unprotected private key|bad passphrase|identity file .* not accessible/i.test(
      s,
    )
  ) {
    return "key_unavailable";
  }
  return null;
}

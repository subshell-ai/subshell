/**
 * Lingering: the Linux fact that decides whether a `--user` service outlives
 * its owner's logout.
 *
 * **Why this one thing is shared when the rest of the two service modules is
 * not.** `apps/server/api/src/service.ts` and `apps/node/agent/src/service.ts`
 * are deliberate ports of each other — sync against async — and that
 * duplication is a decision, not an accident: each owns its own PLATFORM
 * logic, and a shared layer over two callers would be an abstraction over a
 * guess. Two pieces of this feature are not platform logic, though, and both
 * are places where a divergence would be silent rather than loud:
 *
 * - **{@link lingerFromProbe} parses another program's error text.** A regex
 *   over `loginctl`'s wording is brittle by nature; the day it needs
 *   correcting, correcting one copy leaves the other quietly answering wrong
 *   on exactly the headless machine this feature exists for.
 * - **{@link lingerVerdict} is user-facing copy that has to read identically
 *   on two CLIs.** `subshell service status` and `subshell-server service
 *   status` answer the same question about the same mechanism; two spellings
 *   of it is the kind of drift nobody notices and everybody has to
 *   reconcile later.
 *
 * Everything else about the probe — when to run it, what to do with the
 * answer, how to spawn — stays with each port.
 */

/**
 * The argv that asks logind whether a user lingers.
 *
 * **By UID, never by username.** Both service modules already carry a uid for
 * launchd's `gui/<uid>` domain target, there is no environment seam on the
 * agent side to read `$USER` from, and `os.userInfo()` THROWS for a uid with
 * no passwd entry — the ordinary shape of a container. logind accepts either
 * spelling, so the uid costs nothing and removes the question.
 *
 * @param uid - the OS user to ask about
 * @returns the command and its arguments, ready to spawn
 */
export function lingerProbeArgv(uid: number): string[] {
  return ["loginctl", "show-user", String(uid), "--property=Linger"];
}

/** What a spawned probe produced. Both ports' `runCmd` results satisfy this. */
export interface LingerProbeResult {
  /** Process exit code */
  code: number;
  /** Standard output */
  out: string;
  /** Standard error */
  err: string;
}

/**
 * Read a linger answer out of {@link lingerProbeArgv}'s result.
 *
 * Three outcomes, and the middle one is the one to get right:
 *
 * - A clean exit carries `Linger=yes|no`, which is logind's own word. Any
 *   other value, or no such line, is `null`.
 * - **A non-zero exit saying the user is "not logged in or lingering" is ALSO
 *   logind answering.** It holds no record of this user, which means no
 *   session and no linger — so `false`, not unknown. That is the ordinary
 *   reply for a service account on a machine nobody signs in to, which is
 *   precisely the machine whose answer matters, and reading it as unknown
 *   would blank the field exactly where it is most useful.
 * - Anything else — no `loginctl` on PATH, no bus to connect to — is a
 *   question that never reached logind, so `null` rather than a `false`
 *   nobody measured.
 *
 * @param res - the probe's exit code and output
 * @returns whether the user lingers, or `null` when nothing answered
 */
export function lingerFromProbe(res: LingerProbeResult): boolean | null {
  if (res.code !== 0) {
    return /not logged in or lingering/i.test(`${res.out}${res.err}`) ? false : null;
  }
  for (const line of res.out.split("\n")) {
    const [key, ...rest] = line.trim().split("=");
    if (key === "Linger") {
      const value = rest.join("=");
      return value === "yes" ? true : value === "no" ? false : null;
    }
  }
  return null;
}

/**
 * How `service status` states the fact, on either CLI.
 *
 * The `false` case names the remedy rather than only the problem, because the
 * fix is one command and the person reading this is already at a shell on
 * that machine.
 *
 * **`null` deliberately blames nothing.** It covers both "logind did not
 * answer" and "we never asked, because the service manager itself had already
 * failed" — naming a tool that was never run sends someone to debug the wrong
 * thing.
 *
 * @param linger - the fact, or `null` when it could not be established
 * @returns the text after `survives logout      = `
 */
export function lingerVerdict(linger: boolean | null): string {
  if (linger === true) return "yes (user lingers)";
  if (linger === false) return "no: run `loginctl enable-linger $USER`";
  return "unknown (could not be measured)";
}

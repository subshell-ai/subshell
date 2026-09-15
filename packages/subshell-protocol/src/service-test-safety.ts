/**
 * Guards that stop a TEST from changing the machine it runs on.
 *
 * Both CLIs install a per-user service, and both expose the real filesystem and
 * service-manager seams through a `DEFAULT_DEPS` factory. A test that builds
 * those real deps — rather than stubbing them — acts on the developer's own
 * box, and on 2026-09-15 one did: it wrote a launchd agent into
 * `~/Library/LaunchAgents` with `ExecStart` naming a test file, launchd
 * bootstrapped it, and it respawned ten times against the operator's real
 * database before anyone noticed.
 *
 * Stubbing the seam in each harness fixes that harness. These fix the class,
 * and they live HERE because two copies of a safety check is how the two come
 * to disagree — the server and the node each carried a near-verbatim copy for
 * a day, differing already in a comment and an error string.
 *
 * Both are inert unless a test runner is active. They read the REAL
 * `process.env` rather than any injected env: the question is "is a test
 * running", not "what did the caller pass".
 *
 * @packageDocumentation
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** True while a test runner is active (`bun test` sets `NODE_ENV=test`). */
function underTest(): boolean {
  return process.env.NODE_ENV === "test" || process.env.SUBSHELL_TEST_MODE === "1";
}

/**
 * Resolve a path through the deepest ancestor that actually exists.
 *
 * A definition that has never been written cannot be `realpath`'d, and on
 * macOS the UNRESOLVED spelling (`/var/folders/…`) never prefix-matches the
 * resolved temp dir (`/private/var/folders/…`). Resolving the existing part and
 * re-attaching the rest puts both sides in one spelling either way.
 */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Refuse a REAL service-definition write or removal while a test is running.
 *
 * Call it from the PRODUCTION filesystem seam, never from `installService`:
 * the hazard is precisely "a test used the real deps", and tests that stub
 * `writeFile` pass a fake home and never touch a disk. Gating on the home
 * instead would refuse hundreds of those for no safety at all.
 *
 * @param path - the definition path about to be written or removed
 * @throws when a test runner would touch a path outside the OS temp directory
 */
export function assertServiceWriteUnderTest(path: string): void {
  if (!underTest()) return;
  const tmp = realish(tmpdir());
  const target = realish(path);
  if (target === tmp || target.startsWith(`${tmp}/`)) return;
  throw new Error(
    `refusing to touch the service definition at ${path} while NODE_ENV=test — ` +
      "point the deps' home at a temp directory, or stub writeFile/removeFile.",
  );
}

/**
 * Read-only verbs of the two service managers.
 *
 * An ALLOWLIST, so a mutating verb added later is refused by default rather
 * than silently permitted — the opposite choice would make this guard weaker
 * every time systemd grows a subcommand.
 */
const READ_ONLY_MANAGER_VERBS = new Set([
  "show",
  "status",
  "cat",
  "is-enabled",
  "is-active",
  "is-failed",
  "is-system-running",
  "list-units",
  "list-unit-files",
  "print",
  "print-disabled",
  "list",
  "blame",
]);

/**
 * Refuse a REAL service-manager MUTATION while a test is running.
 *
 * Guarding the write alone was not enough: `uninstallService` runs
 * `systemctl --user disable --now` — and on darwin `launchctl bootout` —
 * BEFORE it removes the definition, so a test on the real deps would stop and
 * disable the operator's own running service and only then meet the write
 * guard. Those verbs do not edit a file; they take a live service down, and
 * with it every pane it supervises.
 *
 * Only `systemctl` and `launchctl` are inspected, so `plutil`, the `loginctl`
 * linger probe and the arbitrary commands the spawn-guard suites drive pass
 * through untouched. The verb is the first non-flag argument, which reads both
 * `systemctl --user <verb> <unit>` and `launchctl <verb> <target>`.
 *
 * MUST be called OUTSIDE a `runCmd` try/catch: those turn a throw into
 * `{ code: 127, err: "spawn failed" }`, which would disguise this refusal as a
 * missing service manager.
 *
 * @param cmd - the argv about to be spawned for real
 * @throws when a test runner would mutate this machine's service manager
 */
export function assertManagerCommandUnderTest(cmd: readonly string[]): void {
  if (!underTest()) return;
  const program = basename(cmd[0] ?? "");
  if (program !== "systemctl" && program !== "launchctl") return;
  const verb = cmd.slice(1).find((arg) => !arg.startsWith("-"));
  if (verb !== undefined && READ_ONLY_MANAGER_VERBS.has(verb)) return;
  throw new Error(
    `refusing to run \`${cmd.join(" ")}\` while NODE_ENV=test — it would change this machine's ` +
      "service manager. Inject a runCmd stub for this test.",
  );
}

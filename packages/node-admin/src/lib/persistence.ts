/**
 * The "will this machine bring the process back by itself?" model.
 *
 * Split out of the SPA's `lib/supervision.ts` (which keeps the SUPERVISION
 * question — who runs the server, and the login switch's refusals, both of
 * which speak `ServerDeployment`, a server-only view) because the node's
 * Runtime card answers the same question from a runtime report, and the node's
 * own loopback dashboard answers it about the machine the reader IS sitting
 * at. One model, three surfaces; `machine` is the parameter that keeps the
 * sentences honest about which one speaks.
 */

/**
 * The command that makes a Linux user's services outlive their logout.
 *
 * `$USER` rather than a resolved name on purpose: the person runs this in
 * their own shell ON that machine, and the plane does not know — and has no
 * business guessing — which account the unit belongs to.
 */
export const LINGER_COMMAND = "loginctl enable-linger $USER";

/** The facts that decide whether a machine brings this process back by itself. */
export interface PersistenceInput {
  /** What supervises it, or null when nothing does */
  manager: "launchd" | "systemd" | "app" | null;
  /** Whether a unit/plist exists at all */
  installed: boolean;
  /** Whether that definition starts at login, null when the manager would not say */
  enabled: boolean | null;
  /** Linux: whether the OS user lingers. null on macOS and when logind did not answer */
  linger: boolean | null;
}

/**
 * What to do about an answer of "no", when there is something to do.
 *
 * Deliberately NOT carrying the remedy's copy: what "install it" or "enable
 * it" looks like differs per surface — the server page copies a command, a
 * node page points at the button above it — and a model that shipped the
 * words would be answering a question it cannot see.
 */
export type PersistenceFix =
  /** Nothing is installed; the remedy is installing a definition */
  | { kind: "install" }
  /** A definition exists but does not start on its own */
  | { kind: "enable" }
  /**
   * A systemd user unit that starts at login on a machine whose user does not
   * linger. `measured` is false when logind never answered, so the surface can
   * phrase it as a question rather than as a fault.
   */
  | { kind: "linger"; measured: boolean };

/**
 * The one question a person actually has about a machine they are not sitting
 * at: **will this still be running after a reboot, or after I log out?**
 *
 * This replaces "start at login" as the thing the browser shows. That label
 * was borrowed from the desktop app, where it is a native idea and a real
 * choice; on a headless Linux box it is a trap. It reads as being about a
 * desktop login, an operator switches it off, and the server is gone at the
 * next reboot — while the fact that decides survival there, whether the OS
 * user LINGERS, was never on screen at all. A `systemd --user` unit runs
 * inside its owner's login session: enabled, it comes back when that user logs
 * in and dies when they log out, unless `loginctl enable-linger` decouples the
 * two, after which it comes back at boot with nobody logged in.
 *
 * So: one sentence, and a remedy only where the answer is unsatisfying. The
 * caller decides what a remedy looks like — see {@link PersistenceFix}.
 *
 * @param input - the machine's own facts, from the deployment view or a node's runtime report
 * @param machine - how to NAME the machine in the two sentences that must ("this machine", a node's name)
 */
export function persistence(
  input: PersistenceInput,
  machine: string,
): { sentence: string; fix: PersistenceFix | null } {
  if (input.manager === "app") {
    return {
      sentence: `Runs while the Subshell Server app is open on ${machine}; quitting the app stops it.`,
      fix: null,
    };
  }
  if (!input.installed) {
    return { sentence: "Started by hand. Nothing brings it back when it stops.", fix: { kind: "install" } };
  }
  if (input.enabled === false) {
    return { sentence: "Will not come back after a reboot.", fix: { kind: "enable" } };
  }
  if (input.enabled === null) {
    return { sentence: "Installed, but the service manager did not say whether it starts on its own.", fix: null };
  }
  if (input.manager === "systemd") {
    if (input.linger === true) {
      return { sentence: "Comes back after a reboot, without anyone logging in.", fix: null };
    }
    // Both remaining answers get the same remedy and differ only in how
    // confidently it is offered: `false` is logind saying so, `null` is logind
    // not answering — a container, or no loginctl on PATH.
    return input.linger === false
      ? {
          sentence: "Comes back when you log in, and stops when you log out.",
          fix: { kind: "linger", measured: true },
        }
      : {
          sentence: `Comes back when you log in. If nobody logs in to ${machine}, it needs lingering to stay up.`,
          fix: { kind: "linger", measured: false },
        };
  }
  if (input.manager === "launchd") {
    // No linger equivalent, and none is missing: a LaunchAgent's lifetime IS
    // the login session by design, and a Mac nobody logs in to runs no agents
    // either way. A LaunchDaemon would be the other answer; we do not install
    // one, so there is nothing here to offer.
    return { sentence: `Comes back when you log in to ${machine}.`, fix: null };
  }
  // Installed and armed under a manager this build does not name (win32, or a
  // report from a platform added later). The honest answer is the weaker one.
  return { sentence: "Installed and set to start on its own.", fix: null };
}

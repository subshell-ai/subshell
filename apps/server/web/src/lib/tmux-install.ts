/**
 * What to tell an operator whose control-plane host has no tmux.
 *
 * tmux is what every local pane launches through, so a host without it can run
 * nothing — and the browser wizard used to say so nowhere at all: the tmux
 * screen existed only in the native Subshell Server assistant, which a
 * headless install never sees (spec 2026-09-15 § 5.1).
 *
 * This is a pure table over the platform, deliberately mirroring the server's
 * own `chooseTmuxInstaller` rather than asking it. The browser cannot know
 * which package manager a Linux box has — that needs a PATH probe — so the
 * server answers that question when the Install button is pressed, and this
 * answers the smaller one the page can render before anyone presses anything.
 */

/** The command to run on one platform, and whether the server may run it. */
export interface TmuxInstallHint {
  /** The command, verbatim and copyable. */
  command: string;
  /** Human label for the package manager ("Homebrew", "apt-get"). */
  label: string;
  /**
   * True when the command needs a password the server cannot supply.
   *
   * The wizard's Install button is gated on this being false, and it has to
   * agree with `POST /api/setup/tmux/install`'s own refusal: that route 409s a
   * `sudo`-prefixed argv, because the server runs installers with no terminal
   * and would sit on the password prompt until its deadline. A button offered
   * here for a privileged command would be a control that always fails.
   */
  needsPrivilege: boolean;
  /**
   * Other commands that fit this platform, for hosts the first one does not.
   *
   * Linux is one platform with several package managers and the browser cannot
   * tell which is installed, so both are stated rather than one being guessed
   * at. Empty where the platform has exactly one answer.
   */
  alternatives: readonly string[];
}

/**
 * How to install tmux on this host, or null when nothing is known for it.
 *
 * Null is the honest answer for an unsupported platform rather than a guess —
 * the same rule `chooseTmuxInstaller` follows, where pacman, zypper and win32
 * fall through to "install it yourself".
 *
 * @param os - The host's platform as `GET /api/admin/status` reports it (`runtime.os`: `darwin` | `linux`)
 */
export function tmuxInstallHint(os: string): TmuxInstallHint | null {
  if (os === "darwin") {
    return { command: "brew install tmux", label: "Homebrew", needsPrivilege: false, alternatives: [] };
  }
  if (os === "linux") {
    // apt-get leads because the server's own probe tries it first, so the
    // command shown is the one the host would have used had it been asked.
    return {
      command: "sudo apt-get install -y tmux",
      label: "apt-get",
      needsPrivilege: true,
      alternatives: ["sudo dnf install -y tmux"],
    };
  }
  return null;
}

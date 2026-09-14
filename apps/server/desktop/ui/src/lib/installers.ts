/**
 * Which installer the console offers for tmux, as a pure function of the
 * platform.
 *
 * Separate from `main.ts` for the same reason `config-form.ts` is: this is the
 * part with a contract rather than a rendering, and it is the part worth
 * testing without a webview.
 *
 * **tmux is never bundled.** A static build would mean a musl toolchain in the
 * CI builder image (which strands ~2 GB of layers on every runner that pulled
 * it), a bundled terminfo directory, a second sidecar in the macOS notarize
 * path, and a CVE cadence for a C dependency nothing here owns. The platform's
 * own package manager is the smaller, honest answer.
 *
 * Agent CLI installs used to live here too, mirrored against a Rust
 * enforcement copy in `control.rs` (`AGENT_INSTALLS`). Both are gone (spec
 * 2026-09-11 § 7): installing an agent CLI is now the control plane's job —
 * `POST /api/setup/agents/:id/install` on the server, from the setup
 * assistant's Add an Agent screen — because that is the host with the plugin
 * manifests, and one install serves every launch rather than one desktop
 * user's own machine. This app still gets tmux installed, because tmux has to
 * exist before the server can start a single pane at all.
 */

/** The docs page to send someone to when we cannot run an installer for them. */
const TMUX_DOCS = "https://formulae.brew.sh/formula/tmux";

/**
 * How the console surfaces one install decision.
 * `kind: "run"` means it may offer a button; `"manual"` means it must show
 * the command (when there is one) and let the user run it.
 */
export interface InstallPlan {
  kind: "run" | "manual";
  label: string;
  /** The argv, as words for the reader — empty when the platform has nothing installable. */
  command: string[];
  /** Reading for the case the app cannot handle. An empty string means none. */
  docsUrl: string;
}

/**
 * One way a person can get tmux themselves, when this app cannot do it for
 * them: a package manager's name, and the member of the app's closed URL set
 * that opens its site.
 *
 * **The command is shown only when ASKED FOR.** Printing both routes' shell
 * lines up front asked someone to paste an unexplained command on a window's
 * say-so; pressing a manager's name and being shown the one line for it does
 * not. The line that installs the MANAGER is still never shown — that is the
 * `curl … | bash` nobody should take from here, and each project's own site
 * carries it in its own words (operator's calls, 2026-09-14).
 */
export interface ManualRoute {
  /** The package manager's name, spelled as its own project spells it */
  name: string;
  /** Which member of the app's closed URL set opens this manager's site */
  target: "homebrew" | "macports";
  /** The one line that installs tmux once the manager itself is there */
  command: string;
}

/**
 * The ways out of a Mac with no package manager, both of them.
 *
 * It named MacPorts alone, which is the less likely answer by a wide margin:
 * someone on macOS without a package manager almost certainly wants Homebrew,
 * and the screen never mentioned it — so the one route it offered was the one
 * fewer people would take, and the obvious one looked unsupported (operator's
 * call, 2026-09-14).
 *
 * Homebrew goes first, being the one almost everyone means. Each route carries
 * the single line that installs tmux once that manager exists, and a way to
 * the manager's own site for getting it in the first place.
 *
 * Only darwin has these. Linux gets a button (apt-get via pkexec), and an
 * unknown platform gets the reading link it already had — inventing routes for
 * a platform this app does not ship to would be guessing in the one place a
 * person cannot check the guess.
 * @param platform "darwin", "linux", or anything else
 */
export function manualTmuxRoutes(platform: string): ManualRoute[] {
  if (platform !== "darwin") return [];
  return [
    { name: "Homebrew", target: "homebrew", command: "brew install tmux" },
    { name: "MacPorts", target: "macports", command: "sudo port install tmux" },
  ];
}

/**
 * How to install tmux here.
 * @param platform "darwin", "linux", or anything else
 * @param hasBrew whether `brew` resolves on the login PATH
 */
export function tmuxInstallPlan(platform: string, hasBrew: boolean): InstallPlan {
  if (platform === "darwin") {
    if (hasBrew) {
      return { kind: "run", label: "Install tmux", command: ["brew", "install", "tmux"], docsUrl: TMUX_DOCS };
    }
    // No package manager we can drive. Homebrew itself is too large a thing
    // to install on someone's behalf from a setup screen, so this names the
    // alternative rather than pretending the button could work.
    return {
      kind: "manual",
      label: "Install tmux with MacPorts",
      command: ["sudo", "port", "install", "tmux"],
      docsUrl: TMUX_DOCS,
    };
  }
  if (platform === "linux") {
    // pkexec so the user gets their desktop's own password prompt. A bare
    // sudo from a GUI has no terminal to read a password from and simply
    // hangs until the timeout.
    //
    // `apt-get` is hardcoded, not resolved: the only Linux artifact this app
    // SHIPS is the `.deb` (targets are linux-x64 and Debian-family by that
    // packaging), so apt-get is the manager on every machine this button
    // reaches. A `dev:app` on Fedora sees the installer's own "apt-get not
    // found" in the output pane rather than a guess gone wrong. If shipping
    // wider, resolve the manager in RUST (where `which` works) and pass the
    // answer in as this function does with `hasBrew` — never guess here, and
    // change BOTH copies together (the Rust `tmux_install_argv` mirrors this
    // decision; `the_console_install_table_and_the_rust_one_agree` fails the build
    // when a token either side runs is removed or changed in the other).
    return {
      kind: "run",
      label: "Install tmux",
      command: ["pkexec", "apt-get", "install", "-y", "tmux"],
      docsUrl: TMUX_DOCS,
    };
  }
  // Nothing installable, nothing to show as a command: an empty list means
  // the warning renders only the reading link. Putting "tmux" on the line
  // would read as the fix and cannot be a fix.
  return { kind: "manual", label: "Install tmux", command: [], docsUrl: TMUX_DOCS };
}

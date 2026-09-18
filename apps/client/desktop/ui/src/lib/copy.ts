/**
 * The words this app owns, and the two shapes it checks before spending a key.
 *
 * Everything the CLI says is printed verbatim by `components/output-block.tsx`.
 * What is here is the other half: the things the CLI never gets a chance to
 * say, because they have to be true BEFORE it is invoked — what a setup key is,
 * where it comes from, what a wrong node name costs, and what a loopback URL
 * means. Kept out of the components so the prose can be edited without reading
 * the state machine.
 */
import type { ActionResult, Probe, WebTarget } from "@/lib/ipc";

/** One field of the enrollment form. */
export interface EnrollField {
  name: EnrollFieldName;
  label: string;
  placeholder: string;
}

/** The keys of the enroll form, which are also the keys of its error map. */
export type EnrollFieldName = "server" | "key" | "name";

/** The three fields of the enrollment form, in the order they are filled in. */
export const ENROLL_FIELDS: readonly EnrollField[] = [
  { name: "server", label: "Server URL", placeholder: "https://subshell.example.com" },
  { name: "key", label: "Setup key", placeholder: "nsk_…" },
  // Not "optional", and it is no longer blank-by-default: `enroll` requires a
  // name since the 2026-09-17 node-setup revamp, because the Add-node dialog's
  // guess was never what named the machine. This app asks the person standing at
  // it, which is the one place that knows.
  { name: "name", label: "Node name", placeholder: "e.g. mac mini" },
];

/**
 * The mint shape of a setup key: `nsk_` plus 32 url-safe base64 characters
 * (`randomBytes(24).toString("base64url")`).
 *
 * Matches `validate_setup_key` in `src-tauri/src/control.rs`, which matches the
 * server's own check in `install-script.ts`. Checking it here means a partial
 * paste costs a message rather than a spawn — and never a key, since a
 * malformed one is refused before the CLI is reached.
 */
export const SETUP_KEY_RE = /^nsk_[A-Za-z0-9_-]{32}$/;

/**
 * The node-name cap, imported rather than restated. It was the third spelling of
 * 64 in this repo (the route's schema, the CLI's pre-flight, this const);
 * `NODE_NAME_MAX` in `@internal/subshell-protocol` is now the one, and
 * `normalizeNodeName` beside it is what the control plane stores.
 */

/**
 * Shown live under the Server URL field, and never as a refusal.
 *
 * The Rust side raises the same point as a `loopback-server` confirmation, but
 * that arrives after the user has already pasted the key — so it is also said
 * here, where the URL is still being chosen.
 */
export const LOOPBACK_NOTE =
  "This is a loopback address, so this node will look for a control plane on THIS machine. That is right if you " +
  "run the server here, and wrong if you copied the URL out of a browser on another machine.";

/** What every enrollment screen says about the key, in plain language. */
export const ENROLL_NOTES: readonly string[] = [
  "Mint a setup key in the browser first: Nodes → Add node. It stays listed on the Nodes page until it is used, so " +
    "closing that dialog is not losing the key.",
  "A setup key is single-use and expires after 24 hours. Anything that fails AFTER the control plane has accepted " +
    "it (a node name already taken on that server, or a server-side error) spends it permanently. The answer to " +
    "those is a NEW key, never a retry.",
  "Whatever you call it here is the row on the Nodes page. The control plane stopped guessing this name — it used to " +
    "label the KEY with whatever was typed there and name the machine after its hostname — so the choice is asked " +
    "where the answer is.",
];

/**
 * Which platform this bundled page is running on.
 *
 * The user agent, because this page has no `platform` on its probe — the
 * Rust side reports the AGENT's state, and nothing in that report is about the
 * operating system as such. Read once and named, so the two places that need
 * it read one expression: a second inline regex is how two surfaces come to
 * disagree about which machine they are on.
 *
 * It gates only genuine platform FACTS — which tmux installer to name, and
 * that a Linux app update raises a polkit prompt — never voice. One word for
 * where you are, on both platforms (`node-assistant-state.ts`).
 *
 * ONE regex, asked two ways. {@link IS_MACOS} is the memo, and it is what every
 * constant here reads; the FUNCTION exists for the one decision that has to be
 * pinned on both platforms — {@link manualTmuxRoutes}, whose macOS branch is
 * defined by what it does NOT offer. A const read at module evaluation can only
 * ever be exercised on the platform the test process happens to be, which is
 * the platform that was never the problem.
 */
export function isMacos(): boolean {
  return /Macintosh|Mac OS X/.test(navigator.userAgent);
}

export const IS_MACOS = isMacos();

/**
 * The install command for this machine, named in the hint so the advice is
 * one keystroke from action. The same two installers `commands/tmux-install.ts`
 * offers interactively, and the same pair the server console shows beside its
 * disabled buttons.
 */
export const TMUX_INSTALL_CMD = IS_MACOS ? "brew install tmux" : "sudo apt-get install tmux";

/**
 * One way a person can get tmux themselves, when this app can drive no
 * installer for them.
 *
 * COPIED from `apps/server/desktop/ui/src/lib/installers.ts` (`ManualRoute`,
 * `manualTmuxRoutes`) rather than imported, the same way this app's design
 * tokens and `components/ui/` primitives are — so a diff between the two
 * copies is the drift signal. Same three fields, same two routes, same order.
 *
 * **The command is shown only when ASKED FOR**, and the line that installs the
 * MANAGER is never shown at all: printing both routes' shell lines up front
 * asks someone to paste an unexplained command on a window's say-so, and the
 * manager's own installer is the `curl … | bash` nobody should take from here
 * — each project carries that on its own page, in its own words (operator's
 * calls, 2026-09-14).
 */
export interface ManualTmuxRoute {
  /** The package manager's name, spelled as its own project spells it. */
  name: string;
  /** Which member of the app's closed URL set opens this manager's site. */
  target: Extract<WebTarget, "homebrew" | "macports">;
  /** The one line that installs tmux once that manager exists. */
  command: string;
}

/**
 * The ways out of a Mac with no package manager, both of them.
 *
 * Homebrew first, being the one almost everyone means: the server app offered
 * MacPorts alone for a while, so the likelier answer went unmentioned and
 * looked unsupported (operator's call, 2026-09-14).
 */
const MACOS_TMUX_ROUTES: readonly ManualTmuxRoute[] = [
  { name: "Homebrew", target: "homebrew", command: "brew install tmux" },
  { name: "MacPorts", target: "macports", command: "sudo port install tmux" },
];

/**
 * What to print instead of offering the install — empty on every machine where
 * the install button can really install something.
 *
 * Homebrew is the ONLY macOS installer this app may drive
 * (`desktop_core::tmux::install_argv` answers `None` without it, and
 * `node_install_tmux` then rejects with `NO_MANAGER`), so on a brew-less Mac
 * the button's single possible outcome is a refusal — and `brew install tmux`,
 * the line {@link TMUX_INSTALL_CMD} names there, is advice to run a program
 * that is not on the machine. That was a dead end with tmux as a hard gate in
 * front of it: no install, no register, and the one instruction on screen
 * impossible to follow.
 *
 * Linux never reaches this: `pkexec apt-get` is runnable on every machine this
 * app ships a `.deb` to, so the button stays. Nor does a probe that has not
 * answered yet — the caller passes `true` there, which keeps the screen
 * identical while it is still checking.
 * @param hasBrew whether `brew` resolves on the login PATH (`Probe.hasBrew`)
 */
export function manualTmuxRoutes(hasBrew: boolean): readonly ManualTmuxRoute[] {
  return isMacos() && !hasBrew ? MACOS_TMUX_ROUTES : [];
}

/**
 * The tmux sentence for the screen that is about to need it, or nothing.
 *
 * Two different sentences because the consequence differs. `enroll` preflights
 * tmux before its network call, so a missing one costs a message; the daemon
 * does not, so it comes up ONLINE with an empty harness inventory and 409s
 * every launch — which is the failure nobody attributes to tmux.
 *
 * The actions that need tmux are also DISABLED while this says "not found"
 * (see `StepAction.needsTmux`) — the sentence explains, the disabled button
 * refuses.
 */
export function tmuxHint(probe: Probe | undefined, which: "enroll" | "service"): string {
  if (probe?.tmux) return "";
  return which === "enroll"
    ? `tmux was not found on the login PATH, so enrolling is disabled. \`subshell enroll\` also checks for it before ` +
        `its network call, so a missing tmux costs a message rather than the setup key. Install it (${TMUX_INSTALL_CMD}) to continue.`
    : `tmux was not found on the login PATH, so starting the service is disabled: the node would come up online ` +
        `with no harnesses and refuse every launch. Install it (${TMUX_INSTALL_CMD}), then start or restart the service.`;
}

/** What the tmux screen says about an install that has already run here. */
export interface TmuxInstallFailure {
  /** The sentence that names what went wrong, in the app's own words. */
  headline: string;
  /** The package manager's last word — empty when it said nothing. */
  line: string;
  /** Both streams, for the disclosure — empty when the run produced no output. */
  output: string;
}

/**
 * Whether the tmux install this window ran left the machine still without
 * tmux, and what to say about it (operator's report, 2026-09-18).
 *
 * **MIRRORED from `apps/server/desktop/ui/src/lib/wizard-state.ts`**
 * (`tmuxInstallFailure`, `TmuxInstallFailure`), the way `manualTmuxRoutes`
 * above is, because it is the same act failing the same way on the same
 * machine — a diff between the two copies is the drift signal. The reasoning
 * lives at that copy; the short version is here.
 *
 * Both apps reported a failed install as ONE line beside a button that redrew
 * exactly as it had been. That line was `runner.failure`'s "That did not work.
 * See the output below." here — and there is no output below on this screen,
 * which renders no `DetailsDisclosure` — so the sentence pointed at nothing.
 *
 * **Two failures, not one.** A non-zero exit is `ActionResult.ok`; an install
 * that exits ZERO and still leaves no tmux on the login PATH was
 * indistinguishable from a button nobody had pressed, and gets its own
 * sentence because it has a different fix.
 *
 * `null` means there is nothing to report: no install has run in this window,
 * or tmux is now there — in which case the screen is about to leave by itself.
 *
 * @param result - the install's own result, or nullish if none has run here
 * @param tmuxFound - whether the probe can now see a tmux
 */
export function tmuxInstallFailure(
  result: ActionResult | null | undefined,
  tmuxFound: boolean,
): TmuxInstallFailure | null {
  // `== null`, because this is a boundary: the screen's prop is optional and
  // an absent one means exactly what a null one does — nothing has run here.
  if (result == null || tmuxFound) return null;
  const lastLine = (text: string): string | undefined =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
  // stdout first: a manager narrates its progress there and complains on
  // stderr, so reading in that order puts the complaint at the bottom, where a
  // reader of a terminal looks for it.
  const output = [result.stdout, result.stderr]
    .map((stream) => stream.replace(/\s+$/, ""))
    .filter((stream) => stream !== "")
    .join("\n");
  return {
    headline: result.ok
      ? "The installer finished, but tmux still isn't on this machine's PATH."
      : "The tmux install didn't finish.",
    line: (result.ok ? lastLine(output) : (lastLine(result.stderr) ?? lastLine(result.stdout))) ?? "",
    output,
  };
}

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
import type { Probe } from "@/lib/ipc";

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
 */
export const IS_MACOS = /Macintosh|Mac OS X/.test(navigator.userAgent);

/**
 * The install command for this machine, named in the hint so the advice is
 * one keystroke from action. The same two installers `commands/tmux-install.ts`
 * offers interactively, and the same pair the server console shows beside its
 * disabled buttons.
 */
export const TMUX_INSTALL_CMD = IS_MACOS ? "brew install tmux" : "sudo apt-get install tmux";

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

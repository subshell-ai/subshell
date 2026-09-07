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
  { name: "name", label: "Node name (optional)", placeholder: "this machine's hostname" },
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

/** `EnrollBodySchema`'s `name` maxLength, which the CLI also pre-checks. */
export const MAX_NODE_NAME_LEN = 64;

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
  "Mint a setup key in the browser first: Settings → Nodes → Add node. It is shown once, so copy it before closing " +
    "that dialog.",
  "A setup key is single-use and expires after 24 hours. Anything that fails AFTER the control plane has accepted " +
    "it — a node name already taken on that server, or a server-side error — spends it permanently. The answer to " +
    "those is a NEW key, never a retry.",
  "Leave the name blank to use this machine's hostname.",
];

/**
 * The tmux sentence for the screen that is about to need it, or nothing.
 *
 * Two different sentences because the consequence differs. `enroll` preflights
 * tmux before its network call, so a missing one costs a message; the daemon
 * does not, so it comes up ONLINE with an empty harness inventory and 409s
 * every launch — which is the failure nobody attributes to tmux.
 */
export function tmuxHint(probe: Probe | undefined, which: "enroll" | "service"): string {
  if (probe?.tmux) return "";
  return which === "enroll"
    ? "tmux was not found on the login PATH. `subshell enroll` checks for it before its network call, so a missing " +
        "tmux costs a message rather than the setup key — but install it before enrolling."
    : "tmux was not found on the login PATH. The node will come up online with no harnesses and refuse every " +
        "launch — install tmux, then restart the service.";
}

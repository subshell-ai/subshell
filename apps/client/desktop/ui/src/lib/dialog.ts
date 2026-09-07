/**
 * The one non-command call across the IPC boundary: the native file picker.
 *
 * Kept out of `ipc.ts` so that file stays exactly "the `node_*` contract" — the
 * ACL test reads the command names out of it and compares them to what
 * `permissions/desktop.toml` and `capabilities/node.json` grant, and a
 * plugin call is granted by a different mechanism (`dialog:allow-open` in the
 * capability, not an app permission).
 *
 * Note what is deliberately NOT here: `ask`. The capability grants
 * `dialog:allow-open` and `dialog:allow-message` and no `ask`, because this
 * app's confirmations are several sentences of consequence — what a spent setup
 * key costs, which subshells a restart kills — and a modal that has to be
 * dismissed to re-read the form behind it is the wrong shape for that. They are
 * rendered in the page, by `components/confirm-panel.tsx`.
 */
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Ask for a `subshell` binary to drive, or null when the user cancelled.
 *
 * Whatever comes back is only a candidate: `node_set_agent_bin` runs `version`
 * on it and rejects anything that is not an agent, because the path it persists
 * is executed on every launch.
 */
export async function pickAgentBinaryPath(): Promise<string | null> {
  const chosen = await open({ multiple: false, directory: false, title: "Choose the subshell agent" });
  return typeof chosen === "string" ? chosen : null;
}

/**
 * One sentence per screen, in the assistant's voice.
 *
 * These are the `step-screens.ts` `body` lines, carried across rather than
 * rewritten — they were reviewed copy, and the screens they belonged to are
 * the screens this assistant shows. What changed is the shape around them: a
 * subtitle is at most two lines (spec 2026-09-11 § 3.1), so the longer
 * explanations became the screens' own notes instead of a `notes` array on a
 * card.
 *
 * Sentence case, and they say what will happen or why, never how.
 */

import type { NodeSettings, Probe } from "@/lib/ipc";
import type { NodeScreenId } from "@/lib/node-assistant-state";

/**
 * Where this app is running, mid-sentence, so lower case. ONE string on both
 * platforms (operator's call, 2026-09-12).
 *
 * It used to answer "this Mac" on darwin. The macOS feel this assistant is
 * after comes from its SHAPE — one decision per full-window screen, fixed
 * bar positions, screens that ask nothing never appearing — not from the
 * vocabulary; and the split cost a branch and a test matrix on every string
 * that used it. It was also the mechanism behind a real misreading, since a
 * label ending on "Mac" is a prefix of the other platform's own word.
 */
export function hereLower(): string {
  return "this machine";
}

/** The same word, starting a sentence. */
function hereCap(): string {
  return "This machine";
}

/**
 * The screen's subtitle, or `undefined` where the screen owns its own sentence.
 *
 * Welcome is the one that does: it is a glyph, one line and Continue, and that
 * line IS its content — rendering it here too would print it twice, eight
 * pixels apart (`welcome-screen.tsx` says so at the point it draws it).
 */
export function subtitleFor(
  screen: NodeScreenId,
  probe: Probe | undefined,
  _settings: NodeSettings | undefined,
): string | undefined {
  const here = hereLower();
  switch (screen) {
    case "welcome":
      return undefined;
    case "choice":
      // The title asks the question; this says what the answer does NOT cost,
      // because the screen offers two paths and a person who cannot tell
      // whether the pick is final will read both options twice.
      return "Whichever you pick, the other is still available afterwards.";
    case "tmux":
      // The sibling app's own tmux sentence, with the subject changed: there,
      // the server needs tmux before it can start; here, this machine needs it
      // before it can run a subshell at all.
      return `Every subshell runs in a tmux pane, so ${here} needs it before it can run one.`;
    case "register":
      // The recap is DELETED (operator addendum, 2026-09-22): it restated
      // what the three fields already say on their own labels — Server URL,
      // Setup key, Node name — in a sentence eight pixels above them.
      return "";
    case "startup":
      return `Choose how the node runs on ${here}.`;
    case "progress":
      // Says how long, not what is happening — the checklist under it is the
      // thing that answers that, row by row, as the effects land.
      return "This takes a moment.";
    case "status": {
      if (probe?.status?.nodeId) {
        // Deliberately silent about whether the node is UP. Every state a
        // configured node can be in lands here now, so a sentence claiming
        // one would be wrong in three of them; the screen's own badge and
        // problem line are what answer it.
        const where = probe.status.serverUrl;
        return where ? `${hereCap()} is a node of ${where}.` : `${hereCap()} is a node.`;
      }
      // Plane addresses belong to the LIST now (plane-list ruling): a watcher
      // has many and none is "current", so the Status sentence states the
      // machine. While the first probe is still in flight there is no answer
      // to state, and no subtitle is truer than a guessed one.
      return probe === undefined ? undefined : `${hereCap()} is not a node.`;
    }
    case "service":
      // The "what is a node" half the install explainer no longer carries
      // (operator ruling 2026-09-22, the copy trim): the section's own
      // sentence says what the thing it installs IS.
      return "The node is the small program that connects this machine to the control plane and runs the sessions launched here.";
    case "plane":
      // The LIST's home (operator ruling 2026-09-22): what the screen is,
      // and the one fact a glance cannot infer — that the node's own address
      // is IN the list, marked, rather than elsewhere.
      return "Planes this app can connect to. The address this machine's node reports to is marked.";
    case "connect":
      return "Enter the address of the Subshell server this app should show.";
    case "reset":
      // The operator's one sentence (ruling batch, 2026-09-22, screenshot
      // 59), replacing the pair: what is removed, and that is all it says.
      return "Removes the machine's Subshell node configuration and data.";
    case "about":
      return "What this app is, which versions are running, and under what terms.";
    case "update":
      // Deliberately says nothing about whether one exists: half the answer is
      // a NETWORK read the screen itself makes, and a subtitle that claimed
      // either way would be drawn before anything had been asked.
      //
      // It names BOTH halves because both get a ROW: this app ships the node CLI
      // it drives, and a sentence about the application alone would make our
      // packaging the reader's problem (spec 2026-09-18 § 1). It stops there
      // deliberately — since § 13 the act is a selection, so which halves run
      // is the table's answer and never a subtitle drawn before the probe and
      // the release check have landed.
      return "This app and the node CLI that ships inside it.";
  }
}

/**
 * The tmux warning: the reason the buttons are gated, and the way out.
 *
 * A FACTORY rather than a singleton, because the assistant rebuilds its
 * content on every render and a shared element would be re-parented rather
 * than re-created — which is how the console lost one screen's explanation to
 * whichever surface rendered last. A DOM subtree per caller cannot get that
 * wrong.
 *
 * Nothing here may read the probe at build time — it does not exist yet at
 * that moment. Everything plan-dependent goes through `applyPlan`, which each
 * caller re-runs every render, for the same reason `hidden` is recomputed
 * every render: whatever was decided once here would survive its own fix (tmux
 * appearing, `brew` appearing).
 *
 * The plan is `tmuxInstallPlan` — the platform's own installer, never a
 * bundled binary. The CLI's interactive preflight offers to run the same
 * installer; this is the non-interactive twin for the disabled buttons.
 */
import type { InstallPlan } from "../lib/installers";
import * as ipc from "../lib/ipc";
import { copyButton } from "./copy-button";
import type { AssistantHost } from "./host";

export type TmuxWarning = HTMLElement & { applyPlan: (plan: InstallPlan) => void };

export function buildTmuxWarning(host: AssistantHost, install: () => unknown): TmuxWarning {
  const wrap = document.createElement("div");
  wrap.className = "tmux-warning";
  wrap.hidden = true;
  // Names the whole gate, not just the server verbs: a disabled button whose
  // reason the sentence does not name is the drift this line once was.
  const p = document.createElement("p");
  p.textContent =
    "tmux was not found on the login PATH. The server launches every pane through it, so the actions that " +
    "run or configure the server are disabled until tmux is installed.";
  const row = document.createElement("div");
  row.className = "tmux-warning-row";
  // Ahead of the command it acts on, when the plan says we can run it at
  // all: a user who downloaded a GUI should not be sent to a terminal for
  // the fix a button can perform.
  const installButton = document.createElement("button");
  installButton.type = "button";
  installButton.className = "primary";
  installButton.hidden = true;
  // Wrapped, not passed by name: the guard this calls is built after this
  // function runs at module load (a bare name would be a TDZ ReferenceError
  // and a blank console). A click happens long after evaluation.
  installButton.addEventListener("click", () => install());
  const code = document.createElement("code");
  // Copies what is SHOWN, so the code line and the clipboard cannot disagree.
  // A fixed flash key rather than the command: this warning is built once and
  // `applyPlan` rewrites the line under it, so keying on the text would move
  // the slot mid-flash the first time a plan changed.
  const copy = copyButton(() => code.textContent ?? "", { key: "tmux-install", label: "install command" });
  // Reading, not running: the no-Homebrew plan needs somewhere to go, and
  // spec §6.1 names this page. A button calling a Rust command that holds the
  // URL itself, so no URL is a value that crosses the IPC boundary — the same
  // rule `desktop_open_path` follows. Built here rather than through the
  // screens' `button()`, so the screen-wide busy state never reaches it —
  // which is what this and Copy both want: reading the docs, and copying the
  // fix, are most apt precisely while something else is in flight.
  const docs = document.createElement("button");
  docs.type = "button";
  docs.textContent = "Read the docs";
  docs.addEventListener("click", () => {
    ipc.openTmuxDocs().catch((err: unknown) => host.fail(err));
  });
  row.append(installButton, code, copy, docs);
  wrap.append(p, row);
  // Object.assign rather than a cast: the intersection is what this actually
  // builds (a div carrying a method), and the compiler can see it.
  return Object.assign(wrap, {
    applyPlan: (plan: InstallPlan) => {
      installButton.hidden = plan.kind !== "run";
      installButton.textContent = plan.label;
      // The command line follows the plan rather than a UA guess: on a Mac
      // without Homebrew there is no button, so this line IS the fix, and the
      // plan's MacPorts alternative is the honest thing to show — a brew line
      // would advise installing a tool we just checked is absent. An empty
      // command (a platform with nothing installable) hides the code and its
      // Copy rather than showing "tmux" as a fix it is not.
      code.textContent = plan.command.join(" ");
      code.hidden = plan.command.length === 0;
      copy.hidden = plan.command.length === 0;
      docs.hidden = !plan.docsUrl;
    },
  });
}

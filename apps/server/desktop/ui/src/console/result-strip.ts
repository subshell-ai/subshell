/**
 * One line saying what the last press did, where the press happened.
 *
 * Before the sidebar, a command's own words appeared in a pane directly under
 * the buttons, so "did that work?" was answered by the page's largest element.
 * The pane is a section away now. This strip is what stays behind: the label
 * that was pressed, whether it worked, and a way to go read the words — which
 * is a link rather than a quotation, because most outcomes are one line of
 * "done" and the ones that are not are ten lines of CLI.
 */

import { revealOutput } from "./logs";
import { type ConsoleHost, slots, state } from "./state";

export function renderResultStrip(host: ConsoleHost): void {
  for (const box of slots("data-strip")) {
    box.textContent = "";
    const outcome = state.lastResult;
    // Nothing to report, or an action is running and owns the page's voice.
    if (outcome === null || state.busy) continue;

    const line = document.createElement("p");
    line.className = outcome.ok ? "strip-line" : "strip-line warn-text";
    line.textContent = outcome.ok ? `${outcome.label}: done.` : `${outcome.label} did not work.`;

    if (outcome.hasOutput) {
      const read = document.createElement("button");
      read.type = "button";
      read.className = "linkish";
      read.textContent = "Show output";
      read.addEventListener("click", () => {
        revealOutput();
        host.goTo("logs");
      });
      line.append(read);
    }

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "linkish";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => {
      state.lastResult = null;
      host.render();
    });
    line.append(dismiss);
    box.append(line);
  }
}

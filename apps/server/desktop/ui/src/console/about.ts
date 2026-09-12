/**
 * The About section: what this is, who made it, and under what terms.
 *
 * Shaped like an About box and not like the rest of the console: a centred
 * column — mark, name, version, one sentence, a row of links, the terms, the
 * copyright. The first draft reused Overview's `.facts` grid, which put
 * "Website" and "Company site" in a left label column with URLs beside them;
 * that is a spec sheet, and it read as one. Every desktop app's About is
 * centred because there is nothing to scan or compare — it is a title page.
 *
 * Every string comes from ONE `desktop_about` call rather than being written
 * into this page. The licence facts already exist twice by necessity — once in
 * TypeScript for the CLIs and the SPA, once in Rust for the two desktop apps —
 * and `scripts/license-fields.ts` asserts those two agree with each other and
 * with the root LICENSE. A third copy here would be the one copy that detector
 * does not cover, and a drifted copyright line is invisible: nobody re-reads an
 * About box.
 *
 * The links open in the SYSTEM browser through `openWeb`, which takes a member
 * of a closed set. That the same addresses are also shown on screen does not
 * make sending one back acceptable — displaying an address and navigating to
 * one are different capabilities, and the page holds only the first.
 */

import type { About, WebTarget } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { type ConsoleHost, el, state } from "./state";

export interface AboutSection {
  /** Fetch the facts once, then render. Called on the first entry only. */
  load(): Promise<void>;
  render(): void;
}

export function createAbout(host: ConsoleHost): AboutSection {
  /** The answer, or null until the first successful read. */
  let about: About | null = null;
  /** So a failed read is retried on the next visit rather than remembered forever. */
  let loaded = false;

  /**
   * One link in the row, with a separator before all but the first.
   *
   * Named rather than spelled out: three full URLs side by side are unreadable
   * at any width, and here the address is a means rather than the content —
   * unlike the CLI's `license` output, where the URL IS the deliverable because
   * a terminal cannot be clicked.
   */
  function link(row: HTMLElement, label: string, target: WebTarget): void {
    if (row.childElementCount > 0) {
      const dot = document.createElement("span");
      dot.className = "about-sep";
      dot.setAttribute("aria-hidden", "true");
      dot.textContent = "·";
      row.append(dot);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linkish about-link";
    b.textContent = label;
    b.addEventListener("click", () => {
      ipc.openWeb(target).catch((err: unknown) => host.fail(err));
    });
    row.append(b);
  }

  function render(): void {
    const links = el("about-links");
    links.textContent = "";
    if (about === null) {
      // Not an error state: the first render happens before the read returns.
      for (const id of ["about-name", "about-version", "about-license", "about-copyright"]) {
        el(id).textContent = "";
      }
      return;
    }

    el("about-name").textContent = about.appName;
    // Both versions on one line. They are different programs, and "which
    // versions am I running" is the question an About box is opened to
    // answer — most often to put in a bug report. The server's comes from the
    // probe rather than a second read, so it cannot disagree with the number
    // Overview's hero is showing at the same moment.
    const server = state.probe?.server?.version;
    el("about-version").textContent = server
      ? `Version ${about.appVersion} · Server CLI ${server}`
      : `Version ${about.appVersion}`;

    link(links, "Website", "website");
    link(links, "Licence", "license");
    link(links, about.company, "company");

    el("about-license").textContent = about.licenseSummary;
    el("about-copyright").textContent = about.copyright;
  }

  async function load(): Promise<void> {
    if (loaded) return;
    try {
      about = await ipc.about();
      loaded = true;
    } catch (err) {
      // Surfaced rather than swallowed, and `loaded` stays false so the next
      // visit tries again: this is one read of a few constants, so a failure
      // means something is wrong with the bridge, not with the data.
      host.fail(err);
      return;
    }
    host.render();
  }

  return { load, render };
}

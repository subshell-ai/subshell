/**
 * The Settings section: the tray preference, and the way into a reset.
 *
 * Both were cards in the one scroll before — a single checkbox with the same
 * chrome and weight as the server's own controls, and a `<details>` disclosure
 * that was re-closed on every render so nobody could scroll past an open
 * danger section without reading it. The disclosure is gone: on a page a
 * person chose to open, as its last group, with the button under its own
 * explanation, the sentence is read before the button is reached.
 */
import * as ipc from "../lib/ipc";
import { type ConsoleHost, el, state } from "./state";

/**
 * Why the switch is disabled, in words that stay true for a user who can see
 * their own tray icon while reading them — the probe is a false negative on
 * the older XEmbed tray, so it says DETECTED, never "there is none".
 */
const TRAY_NOT_DETECTED =
  "No system tray was detected on this desktop, so a hidden window would have nowhere to go. GNOME needs an " +
  "AppIndicator extension; KDE and most others have one already. Some older trays cannot be detected at all, so " +
  "an icon may still appear. Install one, then check again.";

export interface SettingsSection {
  /** Read the stored preference and the tray probe. Also the re-check button's path. */
  load(): Promise<void>;
}

export function createSettings(host: ConsoleHost): SettingsSection {
  /**
   * The tray preference, and why it is sometimes offered but not live.
   *
   * On Linux the icon is drawn only where a StatusNotifier host is registered on
   * the session bus: KDE has one, a stock GNOME needs the AppIndicator
   * extension, and where none is registered the icon is silently invisible — so
   * a window hidden into it is unreachable. The Rust side answers that with a
   * real probe rather than a platform check and reports both halves:
   * `traySupported` for whether the switch is live, `trayStatus` for whether an
   * absent tray is worth explaining.
   *
   * - `supported` — the switch works.
   * - `not-detected` — DISABLED, with the reason and a re-check. Deliberately
   *   not hidden: naming the extension is actionable, an absent control is not,
   *   and installing it flips the answer without restarting the app.
   * - `unsupported` — no tray on this platform at all, so the group is not drawn.
   *   The section still has its Reset group, so it is never empty.
   */
  async function load(): Promise<void> {
    let prefs: Awaited<ReturnType<typeof ipc.settings>>;
    try {
      prefs = await ipc.settings();
    } catch (err) {
      // Never leaves the group mid-state or the rejection unhandled: this is
      // also the re-check button's path, and a refused command there must say so.
      host.fail(err);
      return;
    }
    el("prefs-group").hidden = prefs.trayStatus === "unsupported";
    const box = el("close-to-tray") as HTMLInputElement;
    box.checked = prefs.closeToTray;
    box.disabled = !prefs.traySupported;
    el("tray-missing").hidden = prefs.traySupported;
    el("tray-reason").textContent = prefs.traySupported ? "" : TRAY_NOT_DETECTED;
  }

  /**
   * Not through `host.guard`: it re-probes, and a checkbox is not worth two CLI
   * spawns of something it cannot change. It still surfaces a refusal — the
   * Rust side rejects `true` where no tray answered — and it re-reads the
   * preference afterwards, so the box shows what was actually stored rather
   * than what was clicked.
   */
  el("close-to-tray").addEventListener("change", () => {
    void (async () => {
      try {
        await ipc.setCloseToTray((el("close-to-tray") as HTMLInputElement).checked);
        state.problem = "";
      } catch (err) {
        host.fail(err);
      }
      await load();
      host.render();
    })();
  });

  el("tray-recheck").addEventListener("click", () => {
    void load();
  });

  return { load };
}

/**
 * What a screen module may ask the page for, and the two helpers every one of
 * them needs.
 *
 * The console's equivalent was `ConsoleHost` (`console/state.ts`), and the
 * difference is one member: there is no `goTo`. The assistant has no sidebar
 * and no sections — it shows one screen, chosen by `screensFor` or by a
 * `desktop-screen` request — so a module that could navigate would be
 * navigating a structure that does not exist. `close()` is what replaces it:
 * leave a requested screen and go back to whatever the probe implies.
 *
 * No module under `assistant/` imports `wizard.ts`. A cycle back to the entry
 * point is not a type error and not a lint error — it is a temporal dead zone
 * at module evaluation, i.e. a BLANK window on the machine someone is trying
 * to repair. That was the console's rule and it is worth more here, because
 * this page is the only one left that renders with the server down.
 */
import type { Probe } from "../lib/ipc";

export interface AssistantHost {
  /** The latest probe, or null before the first one lands. */
  probe(): Probe | null;
  /** Whether an action is in flight. Every screen disables its controls on it. */
  busy(): boolean;
  setBusy(on: boolean): void;
  /** Re-render the current screen. */
  render(): void;
  /** Re-read the machine. */
  refresh(): Promise<void>;
  /** Record a rejection's words as the page's problem line, and render. */
  fail(err: unknown): void;
  /** Leave a requested screen (reset, update) for whatever the probe implies. */
  close(): void;
}

/**
 * The one way this page reaches its fixed markup. Every id it names is
 * declared in `wizard.html`, and a missing one throws here rather than
 * failing silently three lines later.
 */
export const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the assistant page is missing #${id}`);
  return node;
};

/** A rejected command's words, for the problem line. */
export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The console's shared mutable state, and the contract a section module gets
 * back from the page.
 *
 * One object rather than a module-level `let` per field, because the render
 * path is now spread across a directory: an importer that copied a value out
 * of a `let` would read whatever it held at import time, which is before the
 * first probe. Reading `state.probe` at render time cannot go stale that way.
 *
 * `ConsoleHost` is the OTHER direction, and it exists so no section module
 * imports `main.ts`. A cycle between a section and the entry point is not a
 * type error and not a lint error — it is a temporal dead zone at module
 * evaluation, i.e. a blank console window on a machine someone is trying to
 * repair. The tmux warning's `doInstallTmux` comment records the one time
 * this bit in a single file; across nine modules it would be the default.
 */
import { type ExplicitMap, effectiveForm, type FormValues } from "../lib/config-form";
import type { SectionId } from "../lib/console-nav";
import type { ActionResult, Probe } from "../lib/ipc";

/**
 * What the last action did, for the result strip.
 *
 * The label is the button's own, so the strip says "Restart: done." rather
 * than inventing a second name for what the person just pressed.
 */
export interface ActionOutcome {
  label: string;
  ok: boolean;
  /** Whether the command said anything, i.e. whether "Show output" leads anywhere. */
  hasOutput: boolean;
}

export interface ConsoleState {
  /** Latest probe, or null before the first one lands. */
  probe: Probe | null;
  /** True while a command is in flight; every button is disabled meanwhile. */
  busy: boolean;
  /** Why the last action or probe was REFUSED, in the CLI's words. */
  problem: string;
  /** Which section is on screen. Page memory: the poll never changes it. */
  section: SectionId;
  /** The last settled action, or null before one has run / after Dismiss. */
  lastResult: ActionOutcome | null;
  /**
   * The config form's values, held OUTSIDE the DOM.
   *
   * The form is rebuilt whenever its section is entered, and every guarded
   * action ends with a re-probe — so reading `input.value` at click time
   * raced the rebuild and submitted whatever the fresh inputs happened to
   * hold. The typed value is the state; the input is a view of it.
   */
  form: FormValues;
  /**
   * Which fields to send: chosen before this form opened, or typed into since.
   *
   * The inputs are PREFILLED with the effective configuration, so blankness no
   * longer distinguishes "nobody chose this" from "someone chose empty". This
   * does. A field not in here is sent empty, which is how the CLI is told to
   * keep deriving it, and a field already in config.env starts in here so that
   * saving without touching it cannot wipe it: see `explicitFields`.
   */
  explicit: ExplicitMap;
}

export const state: ConsoleState = {
  probe: null,
  busy: false,
  problem: "",
  section: "overview",
  lastResult: null,
  form: effectiveForm(undefined),
  explicit: {},
};

/** What a section module may ask the page to do. */
export interface ConsoleHost {
  /** Re-render the current section and the chrome around it. */
  render(): void;
  /** Re-read the machine. Only the setup chain's own settle loop needs this. */
  refresh(): Promise<void>;
  /**
   * Wrap an action so two cannot run at once, the UI always re-renders, and a
   * rejection is surfaced instead of leaving every button disabled forever.
   * The label names the press in the result strip.
   */
  guard(label: string, fn: () => Promise<ActionResult | null>, settle?: boolean): () => Promise<void>;
  /** Move to another section and render. */
  goTo(section: SectionId): void;
  /** Record a rejection's words as the page's problem line, and render. */
  fail(err: unknown): void;
}

/**
 * How many extra probes a service action may wait on. A SETTLE, never a
 * poll: each attempt is two CLI spawns, and the manager flips state in well
 * under a second — the point is only that ONE re-probe lands mid-transition
 * and reads "installed but not running" on a server that came up fine.
 * Same budget the Subshell Client's action runner uses, for the same reason.
 *
 * Here rather than beside `guard()` because the setup chain runs its own copy
 * of the loop before opening the dashboard, and two budgets that could drift
 * apart is one more thing than this needs to be.
 */
export const SETTLE_ATTEMPTS = 2;
export const SETTLE_DELAY_MS = 1500;
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A rejected command's words, for the problem line. */
export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The one way this page reaches the DOM. Every id it binds is declared in index.html. */
export const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the console page is missing #${id}`);
  return node;
};

/** Every element carrying a given data attribute — the page-level message slots. */
export const slots = (attr: "data-problem" | "data-strip"): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(`[${attr}]`),
];

/**
 * The console's navigation: which sections exist, which may be used, and
 * what the hero says about the machine.
 *
 * Pure by design — no DOM, no IPC — so the three judgments the sidebar rests
 * on are testable without a webview, the same split `wizard-state.ts` keeps
 * for the setup assistant.
 *
 * The important one is `addressesAvailability`. Before the sidebar, "can this
 * machine be configured right now?" was encoded in WHICH steps listed a
 * "Change addresses…" button — a fact spread across four entries of a table
 * and pinned by a test that read the source. Now a section can be opened
 * whenever the person clicks it, so the answer has to be a value the section
 * renders, and it lives here.
 */
import type { Probe } from "./ipc";

/** The sections, in sidebar order. */
export type SectionId = "overview" | "addresses" | "logs" | "settings" | "about";

/**
 * Sidebar order. The console always opens on the first one.
 *
 * About is LAST and deliberately not inside Settings: it changes nothing, so
 * grouping it with the tray switch and the reset button would put a page that
 * only tells you things among the two that alter the machine.
 */
export const SECTIONS: readonly SectionId[] = ["overview", "addresses", "logs", "settings", "about"];

/** What the sidebar calls each section. */
export const SECTION_LABELS: Record<SectionId, string> = {
  overview: "Overview",
  addresses: "Addresses",
  logs: "Logs",
  settings: "Settings",
  about: "About",
};

/** Whether the Addresses section can offer its form, and why not when it cannot. */
export type Availability = { ok: true } | { ok: false; reason: string };

/**
 * The steps on which saving a configuration can actually work.
 *
 * `no-server` and `setup` are the two where no binary resolves, so every
 * write verb answers "no subshell-server found" — the same fact
 * `config-form.test.ts` pins about the setup step's action list. `init` is
 * excluded for a different reason: the machine HAS a server and no
 * config.env, and the first write must also install and start the service
 * (`doInit`), which is Overview's step and not a save.
 */
const CONFIGURABLE_STEPS = new Set<Probe["next"]>(["unreachable", "install-service", "start", "ready"]);

/**
 * Whether the Addresses section may show its form.
 *
 * Three distinct refusals rather than one, because they send the reader to
 * three different places: set a server up, create its configuration, or wait
 * for the first probe.
 */
export function addressesAvailability(probe: Probe | null): Availability {
  if (probe === null) return { ok: false, reason: "Checking this machine…" };
  if (probe.next === "init") {
    return {
      ok: false,
      reason:
        "This server has no configuration yet. Create it from Overview, where the first save also starts the service.",
    };
  }
  if (!CONFIGURABLE_STEPS.has(probe.next)) {
    return { ok: false, reason: "There is no server to configure yet. Set one up from Overview first." };
  }
  return { ok: true };
}

/** The hero's state word and the colour it (and the Overview nav dot) carries. */
export interface HeroState {
  word: string;
  tone: "ok" | "warn" | "muted";
}

/**
 * The state word, from the same facts the old status chip read.
 *
 * `busy` wins over everything: an action owns the machine's state while it
 * runs, and reporting the pre-action state as though it were current is how a
 * press reads as having done nothing.
 */
export function heroState(probe: Probe | null, busy: boolean): HeroState {
  if (busy) return { word: "Working…", tone: "muted" };
  if (probe === null) return { word: "Checking…", tone: "muted" };
  const svc = probe.service;
  if (svc?.state === "running") return { word: "Running", tone: "ok" };
  if (svc?.installed) return { word: `Installed: ${svc.state ?? "unknown"}`, tone: "warn" };
  if (probe.server) return { word: "Not installed as a service", tone: "muted" };
  return { word: "No server found", tone: "muted" };
}

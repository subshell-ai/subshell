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

/**
 * The sections, in sidebar order.
 *
 * These are IDENTIFIERS, not labels: `settings` names the `section-settings`
 * element, every `goTo("settings")` call and the reset flow that hangs off it,
 * and it kept that id when the sidebar started calling it Application (spec
 * 2026-09-11 § 2.2). Renaming it would touch the reset flow for no behavioural
 * gain — the same distinction the root AGENTS.md draws between a directory
 * name and a component id.
 */
export type SectionId = "overview" | "addresses" | "logs" | "settings" | "about";

/**
 * Flat render order — what `render()` iterates to hide the sections it is not
 * showing. The console always opens on the first one.
 *
 * It equals the tree below read top to bottom (`flattenNavTree`, pinned by
 * test), so there is one order rather than two that can disagree about where
 * Addresses sits.
 *
 * About is LAST and deliberately not inside the group: it changes nothing, so
 * grouping it with the tray switch and the reset button would put a page that
 * only tells you things among the two that alter the machine.
 */
export const SECTIONS: readonly SectionId[] = ["overview", "logs", "addresses", "settings", "about"];

/**
 * What the sidebar calls each section.
 *
 * `settings` is labelled **Application** because Addresses is a setting too —
 * the one that rewrites config.env — and the group above them is what is
 * called Settings now. What is left under that name is this app and this
 * machine: the tray preference and the reset button.
 */
export const SECTION_LABELS: Record<SectionId, string> = {
  overview: "Overview",
  addresses: "Addresses",
  logs: "Logs",
  settings: "Application",
  about: "About",
};

/**
 * A row in the sidebar: a section that stands on its own, or a group that
 * opens to sections.
 *
 * A group is a label and a chevron and is never itself a page (spec § 1). A
 * header that is also a link needs a separate toggle beside it, and every
 * page inside a group then earns a name of its own — which is where
 * "Application" comes from, rather than a page called whatever its group is
 * called. Groups do not nest: one level is what this tree needs, and a second
 * is a design question rather than an extension of this type.
 */
export type NavEntry =
  | { kind: "section"; id: SectionId }
  | { kind: "group"; id: "settings-group"; label: string; children: readonly SectionId[] };

/** The sidebar, as a tree. `main.ts` walks this; nothing else reads it. */
export const NAV_TREE: readonly NavEntry[] = [
  { kind: "section", id: "overview" },
  { kind: "section", id: "logs" },
  { kind: "group", id: "settings-group", label: "Settings", children: ["addresses", "settings"] },
  { kind: "section", id: "about" },
];

/**
 * The tree, read top to bottom. Must equal `SECTIONS` — that equality is the
 * whole reason a flat list and a tree can coexist here, and it is a test
 * rather than a comment.
 */
export function flattenNavTree(tree: readonly NavEntry[]): SectionId[] {
  return tree.flatMap((entry) => (entry.kind === "group" ? [...entry.children] : [entry.id]));
}

/**
 * Whether a group renders open: **the current section decides, and a chevron
 * press overrides it until the section changes.**
 *
 * So the group is open exactly while you are inside it and shut otherwise,
 * and the chevron always works — including to shut a group you are in.
 *
 * The first version made a group holding the current section unconditionally
 * open, so that the sidebar could always say where you are. What that bought
 * was a chevron that refused on the one section a person is most likely to
 * press it from — reported against both this console and the web rail on
 * 2026-09-12, which is why the rule now lives here as one testable function
 * rather than as an expression inside `renderNav`.
 *
 * What it was PROTECTING is real, though, and is now `renderNav`'s job
 * instead: shut over the current section, every row carrying a `current`
 * class is inside the container the group just hid, so the header takes a
 * `holds-current` class and is the thing that says where you are. Dropping
 * the forced-open rule without that leaves the sidebar highlighting nothing.
 */
export function navGroupOpen(override: boolean | undefined, childCurrent: boolean): boolean {
  return override ?? childCurrent;
}

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

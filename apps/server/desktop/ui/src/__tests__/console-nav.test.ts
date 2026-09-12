import { describe, expect, it } from "bun:test";
import { flattenNavTree, heroState, NAV_TREE, navGroupOpen, SECTION_LABELS, SECTIONS } from "../lib/console-nav";
import type { Probe, ProbeStep } from "../lib/ipc";

/** A probe carrying only what the function under test reads. */
const at = (next: ProbeStep, rest: Partial<Probe> = {}): Probe => ({ next, ...rest }) as Probe;

describe("SECTIONS", () => {
  it("is the sidebar order, and the console opens on the first", () => {
    expect([...SECTIONS]).toEqual(["overview", "logs", "settings", "about"]);
    expect(SECTIONS[0]).toBe("overview");
  });

  it("keeps About last, and outside the group", () => {
    // About changes nothing. The group holds the section that alters the
    // machine, so a page that only tells you things does not belong among
    // them — and it sits last because nobody opens this window to read a
    // copyright line.
    expect(SECTIONS.at(-1)).toBe("about");
    const grouped = NAV_TREE.flatMap((entry) => (entry.kind === "group" ? entry.children : []));
    expect(grouped).not.toContain("about");
  });

  it("labels every section", () => {
    for (const id of SECTIONS) expect(SECTION_LABELS[id]).toBeTruthy();
  });

  it("calls the settings section Application, keeping the id it is wired by", () => {
    // The label moved and the id did not: `section-settings`, every
    // `goTo("settings")` and the reset flow behind it all still spell it
    // `settings`. Renaming an identifier to rename a label is how a working
    // reset button stops being reachable.
    expect(SECTION_LABELS.settings).toBe("Application");
    expect(SECTIONS).toContain("settings");
  });
});

describe("NAV_TREE", () => {
  it("reads top to bottom as the flat section order", () => {
    // Two structures, one order. `render()` iterates SECTIONS to hide what it
    // is not showing while the sidebar walks the tree, so a disagreement here
    // is a sidebar whose rows are in a different order from nothing visible
    // at all — and it would never throw.
    expect(flattenNavTree(NAV_TREE)).toEqual([...SECTIONS]);
  });

  it("groups Application under Settings", () => {
    // Addresses used to sit beside it — the setting that rewrites config.env
    // — and left for the SPA's Service page when `desktop_init` went (spec
    // 2026-09-12 § 5.6). What is under that label is what alters THIS
    // machine rather than the server's configuration.
    const groups = NAV_TREE.filter((entry) => entry.kind === "group");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (group?.kind !== "group") throw new Error("expected one group");
    expect(group.label).toBe("Settings");
    expect([...group.children]).toEqual(["settings"]);
  });
});

/**
 * The current section decides, and a chevron press overrides it until the
 * section changes (spec 2026-09-11 §5.2, corrected 2026-09-12).
 *
 * The first version forced a group holding the current section open, which
 * made the chevron a no-op from inside — reported against both this console
 * and the web rail as "I'm not able to collapse things". `undefined` is the
 * ordinary state: nobody has pressed since the last `goTo`.
 */
describe("navGroupOpen", () => {
  it("follows the current section when nobody has pressed", () => {
    expect(navGroupOpen(undefined, true)).toBe(true);
    expect(navGroupOpen(undefined, false)).toBe(false);
  });

  it("lets a press shut a group you are INSIDE", () => {
    // The bug this pins: the old rule returned true here.
    expect(navGroupOpen(false, true)).toBe(false);
  });

  it("lets a press open a group you are outside", () => {
    expect(navGroupOpen(true, false)).toBe(true);
  });
});

describe("heroState", () => {
  it("lets busy win over every machine state", () => {
    expect(heroState(null, true)).toEqual({ word: "Working…", tone: "muted" });
    expect(heroState(at("ready", { service: { installed: true, state: "running" } }), true).word).toBe("Working…");
  });

  it("says it is checking before the first probe", () => {
    expect(heroState(null, false)).toEqual({ word: "Checking…", tone: "muted" });
  });

  it("reads the service, then the binary, then nothing", () => {
    expect(heroState(at("ready", { service: { installed: true, state: "running" } }), false)).toEqual({
      word: "Running",
      tone: "ok",
    });
    expect(heroState(at("start", { service: { installed: true, state: "stopped" } }), false)).toEqual({
      word: "Installed: stopped",
      tone: "warn",
    });
    expect(
      heroState(
        at("install-service", { service: { installed: false }, server: { argv: ["s"], source: "path", version: "1" } }),
        false,
      ),
    ).toEqual({ word: "Not installed as a service", tone: "muted" });
    expect(heroState(at("setup", { service: { installed: false }, server: null }), false)).toEqual({
      word: "No server found",
      tone: "muted",
    });
  });

  it("never renders `undefined` for an installed service with no state word", () => {
    expect(heroState(at("start", { service: { installed: true } }), false).word).toBe("Installed: unknown");
  });
});

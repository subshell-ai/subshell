import { describe, expect, it } from "bun:test";
import { addressesAvailability, heroState, SECTION_LABELS, SECTIONS } from "../lib/console-nav";
import type { Probe, ProbeStep } from "../lib/ipc";

/** A probe carrying only what the function under test reads. */
const at = (next: ProbeStep, rest: Partial<Probe> = {}): Probe => ({ next, ...rest }) as Probe;

describe("SECTIONS", () => {
  it("is the sidebar order, and the console opens on the first", () => {
    expect([...SECTIONS]).toEqual(["overview", "addresses", "logs", "settings", "about"]);
    expect(SECTIONS[0]).toBe("overview");
  });

  it("keeps About last, and outside Settings", () => {
    // About changes nothing. Settings holds the tray switch and the reset
    // button, both of which alter the machine, so a page that only tells you
    // things does not belong among them — and it sits last because nobody
    // opens this window to read a copyright line.
    expect(SECTIONS.at(-1)).toBe("about");
  });

  it("labels every section", () => {
    for (const id of SECTIONS) expect(SECTION_LABELS[id]).toBeTruthy();
  });
});

describe("addressesAvailability", () => {
  it("is ok on exactly the steps where a save can work", () => {
    for (const step of ["unreachable", "install-service", "start", "ready"] as const) {
      expect(addressesAvailability(at(step)).ok, `${step} should be configurable`).toBe(true);
    }
  });

  it("refuses where no binary resolves, naming the way out", () => {
    // The same promise `config-form.test.ts` pins about the setup step's
    // action list: every write verb answers "no subshell-server found" here,
    // so a form whose save could only fail must not be offered.
    for (const step of ["no-server", "setup"] as const) {
      const verdict = addressesAvailability(at(step));
      expect(verdict.ok, `${step} must not be configurable`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("Set one up from Overview");
    }
  });

  it("refuses `init` for its own reason — the first write is not a save", () => {
    const verdict = addressesAvailability(at("init"));
    expect(verdict.ok).toBe(false);
    // Distinct from the no-server sentence: this machine HAS a server, and
    // sending the reader to "set one up" would be a dead end.
    if (!verdict.ok) {
      expect(verdict.reason).toContain("no configuration yet");
      expect(verdict.reason).not.toContain("Set one up from Overview");
    }
  });

  it("refuses before the first probe lands", () => {
    const verdict = addressesAvailability(null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("Checking");
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

/**
 * **Server Addresses** (spec 2026-09-18 § 14), which is the way back from a
 * lockout this app could not otherwise undo: an `https://` base URL marks the
 * session cookie `Secure`, this app opens its `main` window on loopback http,
 * and the value that caused it lived only on the dashboard that had just
 * stopped accepting a sign-in.
 *
 * These tests cover save payloads, refusal conditions, and the screen id's
 * agreement with the Rust enum. Host interaction tests cover navigation.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedAddressForm } from "../lib/config-form";
import type { Probe } from "../lib/ipc";
import { PANE_WARNING } from "../lib/pane-force";
import {
  httpsBaseUrl,
  settingsEdited,
  settingsForce,
  settingsKnown,
  settingsPayload,
  settingsSaveRefusal,
  settingsSupervision,
  settingsUnreadable,
} from "../lib/settings-screen";
import { REQUESTED_SCREENS, screenForRequest } from "../lib/wizard-state";

const RESET_RS = join(import.meta.dir, "../../../src-tauri/src/reset.rs");

/** A machine with a managed server running under a service that spares panes. */
function machine(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "0.10.0",
    server: { argv: ["/home/u/.local/bin/subshell-server"], source: "local-bin", version: "0.10.0" },
    managed: true,
    status: {
      settings: {
        SERVER_PORT: { value: "3080", source: "config.env" },
        HOST: { value: "0.0.0.0", source: "default" },
        APP_BASE_URL: { value: "http://localhost:3080", source: "config.env" },
        TRUSTED_ORIGINS: { value: "https://subshell.example.com", source: "config.env" },
      },
    },
    service: { installed: true, state: "running", paneSafety: "keeps", enabled: true },
    serverChoice: "up-to-date",
    next: "ready",
    error: null,
    tmux: "/usr/bin/tmux",
    platform: "darwin",
    hasBrew: true,
    onboarded: true,
    hostname: "mac",
    supervision: "service",
    supervisor: null,
    pendingInstall: null,
    ...over,
  } as Probe;
}

describe("the https warning", () => {
  it("fires on an https base URL and on nothing else", () => {
    expect(httpsBaseUrl("https://subshell.example.com")).toBe(true);
    // Typed, not yet tidied: a value on its way into a field carries whitespace
    // and whatever case the keyboard was in.
    expect(httpsBaseUrl("  HTTPS://Subshell.Example.COM  ")).toBe(true);
    expect(httpsBaseUrl("http://localhost:3080")).toBe(false);
    expect(httpsBaseUrl("")).toBe(false);
    // The scheme, not the letters: a host that merely starts with the word is
    // an http address and costs this app nothing.
    expect(httpsBaseUrl("http://https.example.com")).toBe(false);
  });
});

describe("what Save sends", () => {
  it("sends the supervision the machine already has, never a new one", () => {
    // The trap this closes: `desktop_setup`'s `supervision` argument is
    // OPTIONAL, and absent means "a background service, armed for login" —
    // today's first-run chain. Sending nothing from a screen about ADDRESSES
    // would install a service on a machine deliberately left in app mode, and
    // arm it at login, as a side effect of editing a port.
    expect(settingsSupervision(machine())).toEqual({ background: true, autostart: true });
    expect(settingsSupervision(machine({ supervision: "app", service: null }))).toEqual({
      background: false,
      autostart: false,
    });
    // A service that is installed but not armed stays unarmed. `enabled: null`
    // is the manager refusing to say, which is not a yes.
    expect(
      settingsSupervision(
        machine({ service: { installed: true, state: "running", enabled: false } } as Partial<Probe>),
      ),
    ).toEqual({ background: true, autostart: false });
    expect(
      settingsSupervision(machine({ service: { installed: true, state: "running", enabled: null } } as Partial<Probe>)),
    ).toEqual({ background: true, autostart: false });
  });

  it("keeps a stored origin list that nobody touched", () => {
    // `configPayload`'s rule, exercised through this screen because this is the
    // screen someone opens to change ONE field: `trustedOrigins` is the one
    // emptyable flag, so omitting a stored list WIPES it.
    const p = machine();
    const form = seedAddressForm(p.status?.settings);
    form.values.port = "4000";
    expect(settingsPayload(p, form)).toEqual({
      port: "4000",
      // Seeded `default`, untouched, so the CLI keeps deriving it. Pinning a
      // derived value is the stale-address failure the prefill exists to avoid.
      host: "",
      baseUrl: "http://localhost:3080",
      trustedOrigins: "https://subshell.example.com",
      supervision: { background: true, autostart: true },
    });
  });
});

describe("the two refusals", () => {
  it("refuses to save without tmux, and says which program is missing", () => {
    // The CLI's own refusal: `init` runs a tmux preflight and returns 1
    // without it, so a Save here could only produce that. The recovery screen
    // gates its Set Up on the same fact.
    expect(settingsSaveRefusal(machine())).toBeNull();
    expect(settingsSaveRefusal(machine({ tmux: null }))).toContain("tmux");
    // Before the first probe there is no machine to save to.
    expect(settingsSaveRefusal(null)).not.toBeNull();
  });

  /**
   * **A failed `status --json` is not an unconfigured machine** (review,
   * 2026-09-18), and here the difference is a wipe. The form seeds from
   * `status.settings`, so a tick whose CLI spawn failed would prefill the
   * DEFAULTS — port 3080 — while the machine runs 4000; the next tick's real
   * settings then make the form look edited and Save writes 3080 over it, from
   * the one screen that exists to repair a server nobody can reach.
   */
  it("holds the form while the machine's configuration is unknown", () => {
    const unreadable = machine({ status: null });
    expect(settingsKnown(unreadable)).toBe(false);
    expect(settingsSaveRefusal(unreadable)).toContain("Reading");

    // A machine with no server binary is a different case and IS known: there
    // is nothing to read, defaults are the right prefill, and this screen is
    // where a first configuration gets written.
    const fresh = machine({ status: null, server: null });
    expect(settingsKnown(fresh)).toBe(true);
    expect(settingsSaveRefusal(fresh)).toBeNull();

    expect(settingsKnown(machine())).toBe(true);
  });

  /**
   * **A hold needs a way out** (second review, 2026-09-18). Holding the form
   * is right, but a server binary whose `status --json` keeps failing — wedged,
   * or timing out on a loaded disk — would leave this screen saying "reading…"
   * forever, with no form and no error, on the machine it exists to repair.
   */
  it("names why it cannot read, and lets a save happen anyway", () => {
    // Nothing to say yet: the first tick has not failed, it has not answered.
    expect(settingsUnreadable(machine({ status: null, error: null }))).not.toBeNull();
    expect(settingsUnreadable(machine())).toBeNull();
    expect(settingsUnreadable(machine({ status: null, server: null }))).toBeNull();

    // With the CLI's own words, those words are what the screen shows.
    const wedged = machine({ status: null, error: "`status --json` failed: timed out after 5s" });
    expect(settingsUnreadable(wedged)).toBe("`status --json` failed: timed out after 5s");

    // And the hold lifts once the person has chosen to configure blind.
    expect(settingsSaveRefusal(wedged)).toContain("Reading");
    expect(settingsSaveRefusal(wedged, true)).toBeNull();
    // The tmux refusal is not a hold and survives the choice.
    expect(settingsSaveRefusal(machine({ status: null, tmux: null }), true)).toContain("tmux");
  });

  it("offers Force only where a definition would actually refuse the restart", () => {
    // The update act's rule, and deliberately the same one: this restart is
    // that restart. `paneRisk` fails closed, so an unreadable definition counts.
    expect(settingsForce(machine(), false)).toBeNull();
    expect(
      settingsForce(machine({ service: { installed: true, state: "running", paneSafety: "kills" } }), false),
    ).toEqual({ checked: false, warning: PANE_WARNING, label: expect.stringContaining("Restart anyway") });
    expect(
      settingsForce(machine({ service: { installed: true, state: "running", paneSafety: "unknown" } }), true)?.checked,
    ).toBe(true);
    // App mode with no definition at all has nothing to overrule — the app's
    // own supervisor signals the main pid and can kill no pane.
    expect(settingsForce(machine({ supervision: "app", service: null }), false)).toBeNull();
  });
});

describe("Save is dead until something is typed", () => {
  it("compares the draft against the machine, not against blankness", () => {
    const p = machine();
    const form = seedAddressForm(p.status?.settings);
    expect(settingsEdited(p, form)).toBe(false);
    form.values.baseUrl = "https://subshell.example.com";
    expect(settingsEdited(p, form)).toBe(true);
    // Whitespace is not an edit: a field someone tabbed through still holds
    // what the machine has.
    const spaced = seedAddressForm(p.status?.settings);
    spaced.values.port = " 3080 ";
    expect(settingsEdited(p, spaced)).toBe(false);
  });
});

describe("the screen id, across the three places that spell it", () => {
  it("routes off REQUESTED_SCREENS like every other requested screen", () => {
    expect(REQUESTED_SCREENS).toContain("settings");
    expect(screenForRequest("settings")).toBe("settings");
  });

  it("is a word the Rust enum admits — for every requested screen, not just this one", () => {
    // `parse_screen` is what turns a tray press or a deep link into the enum,
    // and an unknown word falls to `Home`: the assistant raises onto the screen
    // the probe implies, which on a ready machine bounces the person back to
    // the dashboard they just pressed a tray item away from. The page side has
    // been wrong about this three times (see `screenForRequest`), so the pin is
    // over the whole list rather than over the newest member.
    const rust = readFileSync(RESET_RS, "utf8");
    for (const screen of REQUESTED_SCREENS) {
      expect(rust, `reset.rs must parse "${screen}"`).toContain(`Some("${screen}") =>`);
    }
  });
});

import { describe, expect, it } from "bun:test";
import type { Probe } from "../lib/ipc";
import { paneRisk, recoveryFacts, recoverySubtitle } from "../lib/recovery-model";

/** A probe carrying only what the functions under test read. */
function at(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "1.0.0",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "start",
    error: null,
    tmux: "/usr/bin/tmux",
    platform: "darwin",
    hasBrew: true,
    onboarded: true,
    hostname: "mac",
    ...over,
  } as Probe;
}

/** The rows by label, which is how every assertion below reads them. */
const byLabel = (p: Probe): Record<string, string> =>
  Object.fromEntries(recoveryFacts(p).map((f) => [f.label, f.value]));

describe("recoverySubtitle", () => {
  it("says what each step means", () => {
    expect(recoverySubtitle("no-server")).toContain("does not ship one");
    expect(recoverySubtitle("unreachable")).toContain("Nothing has been changed");
    expect(recoverySubtitle("init")).toContain("no configuration yet");
    expect(recoverySubtitle("install-service")).toContain("not installed as a background service");
    expect(recoverySubtitle("start")).toContain("installed but not running");
  });

  it("says nothing where the title is already the whole sentence", () => {
    // Repeating "Set Up Subshell on this Mac" underneath itself in a smaller
    // type size is the clutter the one-screen design removes.
    expect(recoverySubtitle("setup")).toBe("");
    expect(recoverySubtitle("ready")).toBe("");
  });
});

describe("recoveryFacts", () => {
  it("is empty before the first probe lands", () => {
    expect(recoveryFacts(null)).toEqual([]);
  });

  it("always reports tmux, and marks a missing one bad", () => {
    // From the PROBE, not from `status`: on a clean machine there is no
    // server to ask, and tmux is the hard stop on init and service install.
    expect(byLabel(at()).tmux).toBe("/usr/bin/tmux");
    const missing = recoveryFacts(at({ tmux: null })).find((f) => f.label === "tmux");
    expect(missing?.value).toBe("NOT FOUND");
    expect(missing?.tone).toBe("bad");
  });

  it("shows the binary path and a Reveal, with no resolution-rung jargon", () => {
    // The provenance sub ("installed by this app", "on your login PATH", …)
    // was removed: the operator's ruling 2026-09-23 was that "which rung found
    // it" reads as noise. The row still names the binary and can reveal it.
    const row = recoveryFacts(
      at({ server: { argv: ["/x/subshell-server"], source: "local-bin", version: "1.0.0" } }),
    ).find((f) => f.label === "Server binary");
    expect(row?.value).toBe("/x/subshell-server");
    expect(row?.sub).toBeUndefined();
    expect(row?.reveal).toBe("server-dir");
  });

  it("offers Reveal on a config.env that exists, and says missing when it does not", () => {
    const exists = recoveryFacts(at({ status: { configEnv: { path: "/c/config.env", exists: true } } as never })).find(
      (f) => f.label === "Configuration",
    );
    expect(exists?.reveal).toBe("config-env");
    expect(exists?.sub).toBeUndefined();
    const absent = recoveryFacts(at({ status: { configEnv: { path: "/c/config.env", exists: false } } as never })).find(
      (f) => f.label === "Configuration",
    );
    expect(absent?.reveal).toBeUndefined();
    expect(absent?.sub).toBe("missing");
  });

  it("predicts the MCP failure the user would otherwise meet somewhere else", () => {
    const row = recoveryFacts(at({ status: { mcp: null, mcpError: "no entrypoint" } as never })).find(
      (f) => f.label === "MCP entrypoint",
    );
    expect(row?.tone).toBe("bad");
    expect(row?.value).toContain("no entrypoint");
  });

  it("reports a port answering while the service is not running", () => {
    // Otherwise the screen insists the server is stopped while the app works.
    const p = at({ status: { listen: { listening: true, portRaw: "3080" } } as never });
    expect(byLabel(p).Port).toBe("something is already listening on 3080");
  });

  it("quotes the manager verbatim, crash-throttle detail included", () => {
    const p = at({
      service: { installed: true, state: "stopped", detail: "launchd: spawn scheduled", definitionPath: "/p" } as never,
    });
    expect(byLabel(p).Manager).toBe("stopped, launchd: spawn scheduled");
    expect(byLabel(p).Service).toBe("/p");
  });

  it("marks an unreadable manager state bad rather than calling it stopped", () => {
    const p = at({ service: { installed: true, state: "unknown", definitionPath: "/p" } as never });
    expect(recoveryFacts(p).find((f) => f.label === "Manager")?.tone).toBe("bad");
  });

  it("warns about a teardown that kills live panes", () => {
    const kills = at({ service: { installed: true, paneSafety: "kills", definitionPath: "/p" } as never });
    expect(byLabel(kills).Teardown).toContain("kills live panes");
    const unknown = at({ service: { installed: true, paneSafety: "unknown", definitionPath: "/p" } as never });
    expect(byLabel(unknown).Teardown).toContain("could not be read");
  });

  it("gives the log row a Reveal on a file and a command on the journal", () => {
    const file = recoveryFacts(at({ service: { logPath: "/l/server.log" } as never })).find((f) => f.label === "Logs");
    expect(file?.reveal).toBe("logs");
    const journal = recoveryFacts(at({ service: { logPath: null } as never })).find((f) => f.label === "Logs");
    expect(journal?.reveal).toBeUndefined();
    expect(journal?.value).toContain("journalctl");
    // An OLD server reports neither shape, and gets no row rather than a
    // wrong one.
    expect(recoveryFacts(at({ service: {} as never })).find((f) => f.label === "Logs")).toBeUndefined();
  });

  it("reports an installed server newer than the bundled copy, as a sentence", () => {
    const p = at({ serverChoice: "adopt-installed", bundledVersion: "0.9.0" });
    expect(byLabel(p)["This app's copy"]).toContain("older than the server above");
  });
});

describe("paneRisk", () => {
  it("is false with no service installed — there are no panes to lose", () => {
    expect(paneRisk(at({ service: null }))).toBe(false);
    expect(paneRisk(null)).toBe(false);
  });

  it("is false only when the definition explicitly spares panes", () => {
    expect(paneRisk(at({ service: { installed: true, paneSafety: "keeps" } as never }))).toBe(false);
  });

  it("treats an unreadable definition as unsafe", () => {
    // The warning that turns out to be unnecessary costs a sentence; the one
    // that was needed and absent costs someone's running sessions.
    expect(paneRisk(at({ service: { installed: true, paneSafety: "unknown" } as never }))).toBe(true);
    expect(paneRisk(at({ service: { installed: true, paneSafety: "kills" } as never }))).toBe(true);
    expect(paneRisk(at({ service: { installed: true } as never }))).toBe(true);
  });
});

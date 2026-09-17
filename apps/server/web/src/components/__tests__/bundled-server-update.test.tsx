import { describe, expect, it } from "bun:test";
import { bundledServerUpdate } from "@/components/updates/server-row";
import type { DesktopShell } from "@/lib/desktop";

/** A Subshell SERVER shell — the only one that can bundle a server at all. */
function serverShell(overrides: Partial<DesktopShell> = {}): DesktopShell {
  return { app: "server", version: "0.2.0", platform: "macos", protocol: 1, ...overrides };
}

describe("bundledServerUpdate", () => {
  it("names the bundled version only when it is newer than the running server", () => {
    expect(bundledServerUpdate(serverShell({ bundledServer: "0.3.0" }), "0.2.0")).toBe("0.3.0");
    expect(bundledServerUpdate(serverShell({ bundledServer: "0.2.0" }), "0.2.0")).toBeNull();
    // An older shell sends no `b=` at all, and a browser sends no marker.
    expect(bundledServerUpdate(serverShell(), "0.2.0")).toBeNull();
    expect(bundledServerUpdate(null, "0.2.0")).toBeNull();
  });

  it("says nothing while the server version is still unknown", () => {
    // A cached PWA can outlive the field; offering an update against an
    // unknown current version would be a guess presented as a fact.
    expect(bundledServerUpdate(serverShell({ bundledServer: "0.3.0" }), undefined)).toBeNull();
  });

  it("never offers a DOWNGRADE when the shell is older than the server", () => {
    expect(bundledServerUpdate(serverShell({ platform: "linux", bundledServer: "0.1.0" }), "0.4.0")).toBeNull();
  });

  // Subshell Client ships no server, so it never sends `b=` and the row's
  // offer would be absent anyway. The refusal is explicit because the QUESTION here is
  // "which app is this", and answering it by the absence of an unrelated field
  // is how a later change to that field puts an Update button in a window with
  // no assistant to raise.
  it("offers nothing in Subshell Client, whatever it claims to bundle", () => {
    const client: DesktopShell = { app: "client", version: "0.3.0", platform: "linux", protocol: 1 };
    expect(bundledServerUpdate(client, "0.2.0")).toBeNull();
    expect(bundledServerUpdate({ ...client, bundledServer: "9.9.9" }, "0.2.0")).toBeNull();
  });
});

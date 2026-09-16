import { describe, expect, it } from "bun:test";
import { type ChecklistInputs, checklistItems } from "@/lib/setup-checklist";

/**
 * The "Finish setting up" list (spec 2026-09-15 § 5.2), tested as what it is:
 * a pure function over facts three endpoints already return.
 *
 * `healthy` is an instance with nothing left to do, so every case below is
 * one fact changed — which is also the assertion that the OTHER four items
 * stay silent while one fires. A checklist that over-reports is the same
 * defect as one that under-reports: it stops being read.
 */
function healthy(over: Partial<ChecklistInputs> = {}): ChecklistInputs {
  return {
    tmuxPath: "/opt/homebrew/bin/tmux",
    platform: "linux",
    persistence: { manager: "systemd", installed: true, enabled: true, linger: true },
    host: "0.0.0.0",
    appBaseUrl: "http://box.local:3080",
    trustedOrigins: "",
    usingPlaceholderSecret: false,
    configEnvPath: "/home/ops/.config/subshell-server/config.env",
    anyAgentInstalled: true,
    ...over,
  };
}

/** The ids of what the list reported, in the order it reported them. */
function ids(inputs: ChecklistInputs): string[] {
  return checklistItems(inputs).map((item) => item.id);
}

describe("checklistItems", () => {
  it("reports nothing when there is nothing left to do", () => {
    expect(checklistItems(healthy())).toEqual([]);
  });

  describe("tmux", () => {
    it("fires when the server resolved no tmux, and carries the platform's command", () => {
      const [item] = checklistItems(healthy({ tmuxPath: null, platform: "darwin" }));
      expect(item?.id).toBe("tmux");
      expect(item?.remedy).toEqual({ kind: "command", command: "brew install tmux", label: "Install command" });
      expect(item?.consequence).toMatch(/launch/i);
    });

    it("offers apt-get on linux", () => {
      const [item] = checklistItems(healthy({ tmuxPath: null, platform: "linux" }));
      expect(item?.remedy).toMatchObject({ command: "sudo apt-get install -y tmux" });
    });

    it("offers no command on a platform this build has no table for", () => {
      // An unknown package manager is a hint, not a guess — the same rule
      // `commands/tmux-install.ts` follows when it answers null.
      const [item] = checklistItems(healthy({ tmuxPath: null, platform: "win32" }));
      expect(item?.id).toBe("tmux");
      expect(item?.remedy).toBeNull();
    });
  });

  describe("persistence", () => {
    it("is silent when the machine brings the server back by itself", () => {
      expect(ids(healthy())).not.toContain("persistence");
    });

    it("asks for a service when nothing is installed, and carries persistence()'s own sentence", () => {
      const [item] = checklistItems(
        healthy({ persistence: { manager: null, installed: false, enabled: null, linger: null } }),
      );
      expect(item?.id).toBe("persistence");
      expect(item?.remedy).toEqual({ kind: "persistence", fix: { kind: "install" } });
      expect(item?.consequence).toBe("Started by hand. Nothing brings it back when it stops.");
    });

    it("asks for autostart when a definition exists but does not start itself", () => {
      const [item] = checklistItems(
        healthy({ persistence: { manager: "systemd", installed: true, enabled: false, linger: null } }),
      );
      expect(item?.remedy).toEqual({ kind: "persistence", fix: { kind: "enable" } });
    });

    it("asks for lingering on a systemd host whose user does not linger", () => {
      const [item] = checklistItems(
        healthy({ persistence: { manager: "systemd", installed: true, enabled: true, linger: false } }),
      );
      expect(item?.remedy).toEqual({ kind: "persistence", fix: { kind: "linger", measured: true } });
    });

    it("says nothing about a server the desktop app runs, which has no fix", () => {
      expect(ids(healthy({ persistence: { manager: "app", installed: false, enabled: null, linger: null } }))).toEqual(
        [],
      );
    });
  });

  describe("LAN sign-in", () => {
    /** The configuration `applyConfig`'s third warning is about. */
    const lanTrap = { host: "0.0.0.0", appBaseUrl: "http://localhost:3080", trustedOrigins: "" } as const;

    it("fires on a LAN bind with a loopback base URL and no trusted origin", () => {
      const [item] = checklistItems(healthy(lanTrap));
      expect(item?.id).toBe("lan-origin");
      expect(item?.consequence).toMatch(/Invalid origin/);
      expect(item?.remedy).toEqual({ kind: "link", to: "/settings/service", label: "Addresses" });
      // Two honest ways out of the same problem, in the order of how much
      // they ask for: name the address yourself, or put this server on a
      // network that hands it one.
      expect(item?.alternative).toEqual({
        kind: "link",
        to: "/settings/networking",
        label: "Or reach it over a network",
      });
    });

    it("still fires when the only trusted origins are the built-in loopback defaults", () => {
      // `DEFAULT_TRUSTED_ORIGINS` fills this key when config.env leaves it
      // out, so the deployment view NEVER reports the empty string the CLI
      // predicate tests for. Both entries are loopback, so they answer no
      // browser on another machine.
      expect(ids(healthy({ ...lanTrap, trustedOrigins: "http://localhost:5174,http://localhost:5173" }))).toEqual([
        "lan-origin",
      ]);
    });

    it("is silent once one trusted origin names a reachable address", () => {
      expect(ids(healthy({ ...lanTrap, trustedOrigins: "http://localhost:5174,http://box.local:3080" }))).toEqual([]);
    });

    it("is silent when the base URL is already the address people browse", () => {
      expect(ids(healthy({ ...lanTrap, appBaseUrl: "http://box.local:3080" }))).toEqual([]);
    });

    it("is silent on a loopback-only bind, where no other machine reaches the server at all", () => {
      expect(ids(healthy({ ...lanTrap, host: "127.0.0.1" }))).toEqual([]);
    });

    it("treats an unparseable base URL as not-loopback rather than throwing", () => {
      expect(ids(healthy({ ...lanTrap, appBaseUrl: "not a url" }))).toEqual([]);
    });
  });

  describe("auth secret", () => {
    it("fires while the built-in placeholder is in use, and names config.env", () => {
      const [item] = checklistItems(healthy({ usingPlaceholderSecret: true }));
      expect(item?.id).toBe("auth-secret");
      expect(item?.remedy).toMatchObject({ kind: "command", command: "openssl rand -base64 32" });
      // The fix is a config.env key. Re-running `init` is NOT the fix: it
      // generates a secret only when one is absent, and the placeholder is
      // what "absent" already resolves to.
      expect(item?.remedy).toMatchObject({ note: expect.stringContaining("config.env") });
      expect(JSON.stringify(item)).not.toMatch(/init/i);
    });
  });

  describe("agent CLIs", () => {
    it("fires when this host has none", () => {
      const [item] = checklistItems(healthy({ anyAgentInstalled: false }));
      expect(item?.id).toBe("agent-cli");
      expect(item?.remedy).toEqual({ kind: "link", to: "/nodes/$id", params: { id: "local" }, label: "This machine" });
    });
  });

  it("orders what blocks work above what merely bites later", () => {
    expect(
      ids(
        healthy({
          tmuxPath: null,
          anyAgentInstalled: false,
          host: "0.0.0.0",
          appBaseUrl: "http://localhost:3080",
          trustedOrigins: "",
          usingPlaceholderSecret: true,
          persistence: { manager: null, installed: false, enabled: null, linger: null },
        }),
      ),
    ).toEqual(["tmux", "agent-cli", "lan-origin", "auth-secret", "persistence"]);
  });
});

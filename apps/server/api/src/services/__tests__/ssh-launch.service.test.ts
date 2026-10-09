import { describe, expect, it } from "bun:test";
import { buildSshConfigPath, buildSshKnownHostsPath, renderSshConfigContents } from "@internal/pane-runtime";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { subshellSshConfigPath } from "@/services/nodes/subshell-paths.js";
import { composeSshLaunch, isWireSafeSshDestination } from "@/services/ssh-launch.service.js";

/**
 * The compose half of the ssh launch service (spec 2026-10-07 §5.2, decisions
 * 3/4, handoff 4): the pure function that turns an APPROVED snapshot plus the
 * target machine's dataDir into everything the launch needs. The route matrix
 * (`api/ssh/__tests__/ssh-routes.test.ts`) pins when it runs; this file pins
 * WHAT it returns, byte-exactly, because the agent re-derives the path and
 * refuses a single-byte mismatch.
 */

const SNAP = (over: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire => ({
  alias: "work",
  host: "example.test",
  user: null,
  port: 22,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: [],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
  ...over,
});

const ID = "11111111-2222-4333-8444-555555555555";

describe("isWireSafeSshDestination", () => {
  it("accepts aliases and bare hosts; refuses the option-like, the blank, the oversized and anything with whitespace or control characters", () => {
    for (const ok of ["work", "example.test", "dev@10.0.0.7", "a".repeat(253), "10.0.0.7", "[::1]", "box_1"]) {
      expect(isWireSafeSshDestination(ok)).toBe(true);
    }
    for (const bad of [
      "", // blank answers 400 at the wire schema, and false here all the same
      "-x",
      "-oProxyCommand=evil",
      "has space",
      "tab\tsep",
      "esc\x07ape",
      "a".repeat(254), // past SSH_NAME_MAX_CHARS: the wire grammar's own cap
      "new\nline",
    ]) {
      expect(isWireSafeSshDestination(bad)).toBe(false);
    }
  });
});

describe("composeSshLaunch in relay mode (Task 12, spec 2026-10-08 §9)", () => {
  it("the relay render forces yes on the PINNED file and replaces the snapshot's trust refs", () => {
    const snapshot = SNAP({ knownHostsFiles: ["/home/scripted/.ssh/known_hosts"] });
    const pinPath = buildSshKnownHostsPath("/home/scripted/.subshell", ID);
    const composed = composeSshLaunch({
      snapshot,
      targetDataDir: "/home/scripted/.subshell",
      subshellId: ID,
      hostPinPath: pinPath,
    });
    expect(composed.fileContent).toContain("StrictHostKeyChecking yes");
    expect(composed.fileContent).not.toContain("accept-new");
    expect(composed.fileContent).toContain(`    UserKnownHostsFile ${pinPath}`);
    expect(composed.fileContent).not.toContain("/home/scripted/.ssh/known_hosts"); // B's ambient file is not consulted
    // Same path derivation as the config: the pane's dir holds config + known_hosts + agent.sock.
    expect(pinPath).toBe(`/home/scripted/.subshell/ssh/${ID}/known_hosts`);
  });

  it("absent the pin option, the bytes are the M1 compose byte-for-byte (the accept-new branch is untouched)", () => {
    const snapshot = SNAP();
    const plain = composeSshLaunch({ snapshot, targetDataDir: "/home/n/.subshell", subshellId: ID });
    expect(plain.fileContent).toBe(renderSshConfigContents(snapshot));
    expect(plain.fileContent).toContain("accept-new");
  });
});

describe("composeSshLaunch", () => {
  it("composes the config at the target machine's derived path, with the rendered bytes and the full option tail", () => {
    const snapshot = SNAP();
    const composed = composeSshLaunch({ snapshot, targetDataDir: "/home/scripted/.subshell", subshellId: ID });
    const configPath = buildSshConfigPath("/home/scripted/.subshell", ID);
    expect(composed.configPath).toBe(configPath);
    expect(composed.fileContent).toBe(renderSshConfigContents(snapshot));
    // Handoff 4, verbatim: option tokens (with `-F` first) then `--` then the host.
    expect(composed.presetFlags).toEqual(["-F", configPath, "-p", "22", "--", "example.test"]);
    // No agent socket named means no SSH_AUTH_SOCK added — decision 3's scope
    // rule: non-ssh panes never carry it, and neither does an ssh pane that
    // resolved without one.
    expect(composed.extraPaneEnv).toBeUndefined();
  });

  it("the LOCAL machine's dataDir is the server's own, and the byte-derived path is the one LocalLauncher enforces", () => {
    const composed = composeSshLaunch({ snapshot: SNAP(), targetDataDir: SUBSHELL_SERVER_DATA_DIR, subshellId: ID });
    expect(composed.configPath).toBe(subshellSshConfigPath(ID));
  });

  it("a snapshot naming an agent socket carries it as SSH_AUTH_SOCK; a user, non-default port, alias and jump chain ride the option tokens", () => {
    const snapshot = SNAP({
      user: "dev",
      port: 2222,
      hostKeyAlias: "bastion",
      authAgentSocket: "/run/user/501/ssh-agent.sock",
      proxyJumps: [{ host: "jump.example", user: "j", port: 22 }],
    });
    const composed = composeSshLaunch({ snapshot, targetDataDir: "/home/n/.subshell", subshellId: ID });
    expect(composed.extraPaneEnv).toEqual({ SSH_AUTH_SOCK: "/run/user/501/ssh-agent.sock" });
    const flags = composed.presetFlags;
    expect(flags.slice(0, 2)).toEqual(["-F", composed.configPath]);
    expect(flags).toContain("-p");
    expect(flags[flags.indexOf("-p") + 1]).toBe("2222");
    expect(flags).toContain("-l");
    expect(flags[flags.indexOf("-l") + 1]).toBe("dev");
    expect(flags).toContain("HostKeyAlias=bastion");
    expect(flags.some((f) => f.startsWith("ProxyJump=") && f.includes("j@jump.example"))).toBe(true);
    expect(flags.slice(-2)).toEqual(["--", "example.test"]);
  });

  it("refuses a snapshot the frozen grammar cannot express, rather than render it (the belt beside the RPC validator)", () => {
    const forged = { ...SNAP(), host: "-oProxyCommand=evil" } as unknown as SshConnectionSnapshotWire;
    expect(() => composeSshLaunch({ snapshot: forged, targetDataDir: "/home/n/.subshell", subshellId: ID })).toThrow();
  });
});

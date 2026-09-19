/**
 * The facts list, as a pure function of a probe.
 */
import { describe, expect, it } from "bun:test";
import { fmtAge, probeFacts } from "@/lib/probe-facts";
import { makeProbe, makeSettings } from "./harness";

const facts = (args: Parameters<typeof probeFacts>[0]) => probeFacts(args);
const value = (list: ReturnType<typeof probeFacts>, key: string) => list.find((f) => f.key === key);

describe("fmtAge", () => {
  it("reads seconds, minutes and hours", () => {
    expect(fmtAge(4_000)).toBe("4s");
    expect(fmtAge(95_000)).toBe("1m 35s");
    expect(fmtAge(3_723_000)).toBe("1h 2m");
  });

  it("answers null for an absent or nonsense field", () => {
    expect(fmtAge(undefined)).toBeNull();
    expect(fmtAge(Number.NaN)).toBeNull();
    expect(fmtAge(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("never reports a negative age from a clock that moved", () => {
    expect(fmtAge(-5_000)).toBe("0s");
  });
});

describe("probeFacts", () => {
  it("is empty before the first probe", () => {
    expect(facts({ probe: undefined, settings: undefined, enrolledNode: null })).toEqual([]);
  });

  it("translates the ladder rung into something a non-CLI user can read", () => {
    const list = facts({
      probe: makeProbe({ nodeBinary: { argv: ["/usr/bin/subshell"], source: "service", version: "1.9.0" } }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(list, "found via")?.value).toBe("the installed service definition");
  });

  /**
   * The node's control-plane address belongs to `node-plane-card`, which is the
   * only surface that can change it — and which carries the loopback warning
   * now (`__tests__/repoint.test.tsx` pins that). Restating it here would be a
   * second copy of one address on one page.
   */
  it("does NOT restate the node's control-plane address", () => {
    const list = facts({
      probe: makeProbe({ status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true } }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(list, "control plane")).toBeUndefined();
  });

  // The CLI's own sentence for why it could not read a config — "no config at
  // … — enroll this node first" vs "config corrupt" — is not something to
  // paraphrase, and it replaces the daemon fact rather than sitting beside it.
  it("quotes the CLI's reason when there is no node", () => {
    const list = facts({
      probe: makeProbe({
        status: { nodeId: null, online: false, reason: "no config at /home/u/.config/subshell/config.json" },
      }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(list, "config")?.value).toContain("no config at");
    expect(value(list, "daemon")).toBeUndefined();
  });

  it("names the teardown cost, which no service manager will state", () => {
    const kills = facts({
      probe: makeProbe({ service: { installed: true, state: "running", paneSafety: "kills", definitionPath: "/u" } }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(kills, "teardown")?.value).toContain("kills live subshells");

    const unknown = facts({
      probe: makeProbe({ service: { installed: true, state: "running", paneSafety: "unknown", definitionPath: "/u" } }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(unknown, "teardown")?.value).toContain("could not be read");

    const keeps = facts({ probe: makeProbe(), settings: undefined, enrolledNode: null });
    expect(value(keeps, "teardown")).toBeUndefined();
  });

  it("shows the bundled version's note only for the two choices that are news", () => {
    for (const [choice, expected] of [
      ["upgrade-available", "warn"],
      ["adopt-installed", "warn"],
      ["up-to-date", undefined],
      ["install-bundled", undefined],
    ] as const) {
      const list = facts({ probe: makeProbe({ nodeChoice: choice }), settings: undefined, enrolledNode: null });
      expect(value(list, "bundled")?.tone, choice).toBe(expected);
    }
  });

  it("names the node only when THIS session chose the name", () => {
    const probe = makeProbe();
    const nodeId = probe.status?.nodeId as string;
    const anonymous = facts({ probe, settings: undefined, enrolledNode: null });
    expect(value(anonymous, "node")?.value).toBe(nodeId);

    const named = facts({ probe, settings: undefined, enrolledNode: { nodeId, name: "workstation" } });
    expect(value(named, "node")?.value).toBe(`${nodeId} "workstation"`);

    // A name recorded for a DIFFERENT node is not this node's name.
    const stale = facts({ probe, settings: undefined, enrolledNode: { nodeId: "other", name: "laptop" } });
    expect(value(stale, "node")?.value).toBe(nodeId);
  });

  it("surfaces a hand-chosen binary, since that path is executed every launch", () => {
    const list = facts({
      probe: makeProbe(),
      settings: makeSettings({ nodeBinPath: "/opt/subshell/subshell" }),
      enrolledNode: null,
    });
    expect(value(list, "chosen binary")?.value).toBe("/opt/subshell/subshell");
  });

  // The manager row says what launchd/systemd said, not just a coarse word:
  // "launchd: spawn scheduled" is a crash-throttled restart, and a plain
  // "stopped" hides the crash loop — the 2026-09-07 lesson, ported from the
  // server console. And an unanswerable manager is BAD, not merely noted:
  // it is not the same fact as a stopped service.
  it("carries the manager's verbatim detail, and reddens an unknown state", () => {
    const scheduled = facts({
      probe: makeProbe({
        service: { installed: true, state: "stopped", pid: null, detail: "launchd: spawn scheduled" },
      }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(scheduled, "manager")?.value).toInclude("launchd: spawn scheduled");
    expect(value(scheduled, "manager")?.tone).toBeUndefined();

    const unknown = facts({
      probe: makeProbe({
        service: { installed: true, state: "unknown", detail: "launchctl print failed (exit 5): …" },
      }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(unknown, "manager")?.tone).toBe("bad");
    expect(value(unknown, "manager")?.value).toInclude("launchctl print failed");
  });

  // Where the agent's own output goes — the file on macOS, the journal
  // sentence where the platform has no file. The reveal buttons act on these;
  // the rows make them READABLE, which is what the server console added.
  it("shows the log location the CLI reported", () => {
    const mac = facts({
      probe: makeProbe({
        paths: {
          configDir: "/Users/u/.config/subshell",
          configFile: "/Users/u/.config/subshell/config.json",
          dataDir: "/Users/u/.config/subshell/data",
          nodeLog: "/Users/u/Library/Logs/subshell.log",
          nodeLogHint: null,
        },
      }),
      settings: undefined,
      enrolledNode: null,
    });
    expect(value(mac, "logs")?.value).toBe("/Users/u/Library/Logs/subshell.log");
    // The default fixture is the Linux shape — the hint, not a path.
    const linux = facts({ probe: makeProbe(), settings: undefined, enrolledNode: null });
    expect(value(linux, "logs")?.value).toInclude("journalctl --user -u subshell.service");
  });

  it("always reports tmux, and marks its absence as bad", () => {
    expect(value(facts({ probe: makeProbe(), settings: undefined, enrolledNode: null }), "tmux")?.tone).toBeUndefined();
    const missing = facts({ probe: makeProbe({ tmux: null }), settings: undefined, enrolledNode: null });
    expect(value(missing, "tmux")?.tone).toBe("bad");
  });
});

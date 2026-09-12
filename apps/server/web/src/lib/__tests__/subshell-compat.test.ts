import { describe, expect, it } from "bun:test";
import { buildNodeOptions, buildProfileOptions, harnessFitsNode } from "@/lib/subshell-compat";
import type { Node } from "@/types/node";

function node(overrides: Partial<Node>): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}
const CLAUDE_ON = { harnessId: "claude-code", name: "Claude Code", installed: true };
// A plugin the node declared whose PROGRAM was not found. There is no third
// state any more: "disabled" went with the enable flag (spec 2026-09-09 §12).
const CLAUDE_NO_BINARY = { harnessId: "claude-code", name: "Claude Code", installed: false };
const PROF = { id: "p1", name: "Default", harnessId: "claude-code", nodeId: null };

describe("harnessFitsNode", () => {
  it("fits when the node declared the plugin and its program was found", () => {
    expect(harnessFitsNode(node({ harnesses: [CLAUDE_ON] }), "claude-code")).toBeNull();
  });
  it("an absent entry is 'not-installed'", () => {
    expect(harnessFitsNode(node({ harnesses: [] }), "claude-code")).toBe("not-installed");
  });
  it("a declared plugin whose program is missing is also 'not-installed'", () => {
    // Two different facts collapse to one verdict here on purpose: from a
    // launcher's point of view, "no plugin" and "plugin but no program" are
    // both "you cannot start this here". The node page keeps them apart.
    expect(harnessFitsNode(node({ harnesses: [CLAUDE_NO_BINARY] }), "claude-code")).toBe("not-installed");
  });
  it("an offline agent is 'offline' regardless of the entry", () => {
    const n = node({ status: "offline", harnesses: [CLAUDE_ON] });
    expect(harnessFitsNode(n, "claude-code")).toBe("offline");
  });
  it("local is never 'offline' (status is a projection it does not gate on)", () => {
    const n = node({ id: "local", kind: "local", status: "offline", harnesses: [CLAUDE_ON] });
    expect(harnessFitsNode(n, "claude-code")).toBeNull();
  });
});

describe("buildProfileOptions", () => {
  it("without a node, everything is selectable and labels keep the e2e-pinned format", () => {
    const [opt] = buildProfileOptions([PROF], null);
    expect(opt).toEqual({ value: "p1", label: "Default (claude-code)", disabled: false });
  });
  it("an enabled option omits the 'reason' key entirely", () => {
    // bun's toEqual treats undefined-valued keys as absent, so only an `in`
    // check can pin key-absence on enabled options.
    const opt = buildProfileOptions([PROF], null)[0];
    expect(opt && "reason" in opt).toBe(false);
  });
  it("greys an incompatible profile with the node-appropriate reason", () => {
    const n = node({ id: "mac", name: "mac", harnesses: [CLAUDE_NO_BINARY] });
    expect(buildProfileOptions([PROF], n)[0]).toEqual({
      value: "p1",
      label: "Default (claude-code)",
      disabled: true,
      reason: "not installed on this node",
    });
  });
  it("a stale inventory makes 'not installed' honest as last-known", () => {
    const n = node({ harnesses: [], inventoryStale: true });
    expect(buildProfileOptions([PROF], n)[0]?.reason).toBe("not installed here (inventory may be outdated)");
  });
  it("an offline node reasons 'node offline'", () => {
    const n = node({ status: "offline", harnesses: [CLAUDE_ON] });
    expect(buildProfileOptions([PROF], n)[0]?.reason).toBe("node offline");
  });

  it("puts what can be launched first, keeping the caller's order within each group", () => {
    // The report this came from (2026-09-11): on a fresh machine the Agent
    // picker put Terminal — selectable — sixth, under five greyed "not
    // installed on this node" rows. The reasons still show; they sit under
    // the rows a hand can land on.
    const here = node({ harnesses: [CLAUDE_ON] });
    const profiles = [
      { id: "codex", name: "Default", harnessId: "codex", nodeId: null },
      { id: "claude", name: "Default", harnessId: "claude-code", nodeId: null },
      { id: "pi", name: "Default", harnessId: "pi", nodeId: null },
    ];
    expect(buildProfileOptions(profiles, here).map((o) => [o.value, o.disabled])).toEqual([
      ["claude", false],
      ["codex", true],
      ["pi", true],
    ]);
  });
});

describe("buildNodeOptions", () => {
  // The label now comes from the ROW's own name — it used to come from a
  // hardcoded caller argument, which is why this fixture could be called
  // "host" while the option read "Local".
  const LOCAL = node({
    id: "local",
    name: "Server",
    kind: "local",
    access: "view",
    harnesses: [CLAUDE_ON],
    os: "linux",
    arch: "x64",
  });
  const AGENT = node({ id: "a1", name: "mac-mini", harnesses: [] });
  it("without a profile, only offline agents are disabled and labels carry the platform", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], null, null);
    expect(opts[0]).toEqual({ value: "local", label: "Server · linux/x64", disabled: false });
    expect(opts[1]).toEqual({ value: "a1", label: "mac-mini", disabled: false });
  });
  it("a selected profile greys nodes lacking its harness", () => {
    const [localOpt, agentOpt] = buildNodeOptions([LOCAL, AGENT], PROF, null);
    expect(localOpt?.disabled).toBe(false);
    expect(agentOpt).toEqual({ value: "a1", label: "mac-mini", disabled: true, reason: "no claude-code here" });
  });
  it("the suggestion suffix keys off suggestionId alone — the caller passes only validated suggestions", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], PROF, "local");
    expect(opts[0]?.label).toBe("Server · linux/x64 · default for this profile");
  });
  it("a stale inventory hedges the node-side missing-harness reason (mirror of the profile side)", () => {
    const stale = node({ id: "a9", name: "ghost", harnesses: [], inventoryStale: true });
    expect(buildNodeOptions([stale], PROF, null)[0]?.reason).toBe("no claude-code here (inventory may be outdated)");
  });
  // The case that used to sit here asserted that a stale inventory does NOT
  // hedge a "disabled" verdict, because enablement was server-side config
  // rather than something the inventory reported. There is no enable flag any
  // more, so every not-usable verdict now rests on the inventory and every one
  // of them hedges. The row above is that assertion.
  it("selectable nodes come first, in the caller's order — same rule as the profile list", () => {
    const offline = node({ id: "a2", name: "old", status: "offline", harnesses: [CLAUDE_ON] });
    const opts = buildNodeOptions([offline, LOCAL, AGENT], PROF, null);
    // LOCAL runs claude-code; AGENT declares nothing and `old` is offline.
    expect(opts.map((o) => [o.value, o.disabled])).toEqual([
      ["local", false],
      ["a2", true],
      ["a1", true],
    ]);
  });

  it("an offline agent stays disabled with the offline label and no reason text", () => {
    const opts = buildNodeOptions(
      [node({ id: "a2", name: "old", status: "offline", harnesses: [CLAUDE_ON] })],
      PROF,
      null,
    );
    expect(opts[0]).toEqual({ value: "a2", label: "old (offline)", disabled: true });
  });
});

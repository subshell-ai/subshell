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
const CLAUDE_ON = { harnessId: "claude-code", enabled: true, installed: true };
const CLAUDE_OFF = { harnessId: "claude-code", enabled: false, installed: true };
const PROF = { id: "p1", name: "Default", harnessId: "claude-code", nodeId: null };

describe("harnessFitsNode", () => {
  it("fits when the entry is enabled and installed", () => {
    expect(harnessFitsNode(node({ harnesses: [CLAUDE_ON] }), "claude-code")).toBeNull();
  });
  it("an absent entry is 'not-installed' — the lazy default never grants a launch", () => {
    expect(harnessFitsNode(node({ harnesses: [] }), "claude-code")).toBe("not-installed");
  });
  it("an installed-but-disabled entry is 'disabled'", () => {
    expect(harnessFitsNode(node({ harnesses: [CLAUDE_OFF] }), "claude-code")).toBe("disabled");
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
    const n = node({ id: "mac", name: "mac", harnesses: [CLAUDE_OFF] });
    expect(buildProfileOptions([PROF], n)[0]).toEqual({
      value: "p1",
      label: "Default (claude-code)",
      disabled: true,
      reason: "disabled on this node",
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
});

describe("buildNodeOptions", () => {
  const LOCAL = node({
    id: "local",
    name: "host",
    kind: "local",
    access: "view",
    harnesses: [CLAUDE_ON],
    os: "linux",
    arch: "x64",
  });
  const AGENT = node({ id: "a1", name: "mac-mini", harnesses: [] });
  it("without a profile, only offline agents are disabled and labels carry the platform", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], null, null);
    expect(opts[0]).toEqual({ value: "local", label: "Local · linux/x64", disabled: false });
    expect(opts[1]).toEqual({ value: "a1", label: "mac-mini", disabled: false });
  });
  it("a selected profile greys nodes lacking its harness", () => {
    const [localOpt, agentOpt] = buildNodeOptions([LOCAL, AGENT], PROF, null);
    expect(localOpt?.disabled).toBe(false);
    expect(agentOpt).toEqual({ value: "a1", label: "mac-mini", disabled: true, reason: "no claude-code here" });
  });
  it("the suggestion suffix keys off suggestionId alone — the caller passes only validated suggestions", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], PROF, "local");
    expect(opts[0]?.label).toBe("Local · linux/x64 · default for this profile");
  });
  it("a stale inventory hedges the node-side missing-harness reason (mirror of the profile side)", () => {
    const stale = node({ id: "a9", name: "ghost", harnesses: [], inventoryStale: true });
    expect(buildNodeOptions([stale], PROF, null)[0]?.reason).toBe("no claude-code here (inventory may be outdated)");
  });
  it("a stale inventory does NOT hedge the 'disabled' reason (entry state is confirmed)", () => {
    const stale = node({ id: "a9", name: "ghost", harnesses: [CLAUDE_OFF], inventoryStale: true });
    expect(buildNodeOptions([stale], PROF, null)[0]?.reason).toBe("no claude-code here");
  });
  it("an offline agent stays disabled with the offline label and no reason text", () => {
    const opts = buildNodeOptions(
      [node({ id: "a2", name: "old", status: "offline", harnesses: [CLAUDE_ON] })],
      PROF,
      null,
    );
    expect(opts[0]).toEqual({ value: "a2", label: "old — offline", disabled: true });
  });
});

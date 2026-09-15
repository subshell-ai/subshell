import { describe, expect, it } from "bun:test";
import type { InstancePluginRow } from "@/hooks/use-instance-plugins";
import {
  buildAgentOptions,
  buildNodeOptions,
  defaultAgentId,
  harnessFitsNode,
  type LaunchAgent,
} from "@/lib/subshell-compat";
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
    canLaunch: true,
    allowedDirs: [],
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    held: null,
    ...overrides,
  };
}
const CLAUDE_ON = { harnessId: "claude-code", name: "Claude Code", installed: true };
// A plugin the node declared whose PROGRAM was not found. There is no third
// state any more: "disabled" went with the enable flag (spec 2026-09-09 §12).
const CLAUDE_NO_BINARY = { harnessId: "claude-code", name: "Claude Code", installed: false };

/** One plugin row; only the fields the compat matrix reads. */
function plugin(p: {
  id: string;
  name?: string;
  installed?: boolean;
  enabled?: boolean;
  broken?: string;
  type?: "agent-harness" | "terminal";
  icon?: string;
}): LaunchAgent {
  const row: InstancePluginRow = {
    id: p.id,
    name: p.name ?? p.id,
    description: "",
    installed: p.installed ?? true,
    enabled: p.enabled ?? true,
    builtIn: true,
    ...(p.broken !== undefined ? { broken: p.broken } : {}),
    ...(p.type !== undefined ? { type: p.type } : {}),
    ...(p.icon !== undefined ? { icon: p.icon } : {}),
  };
  return row;
}
const CLAUDE = plugin({ id: "claude-code", name: "Claude Code", icon: "icon.svg" });
const PI = plugin({ id: "pi", name: "Pi" });
const TERM = plugin({ id: "terminal", name: "Terminal", type: "terminal" });

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

describe("buildAgentOptions", () => {
  const HERE = node({ id: "local", kind: "local", harnesses: [CLAUDE_ON] });

  it("without a node, a healthy plugin is selectable; label is the name, icon carried", () => {
    const [opt] = buildAgentOptions([CLAUDE], null);
    // The icon is a `PluginIcon` element now, not the manifest's path: the
    // path names a file inside the plugin package and means nothing to a
    // browser, so the component turns the plugin id into the image route.
    expect(opt).toMatchObject({ value: "claude-code", label: "Claude Code", disabled: false });
    expect(opt?.icon).toBeDefined();
  });
  it("a plugin with no icon still carries one — the monogram keeps the rows aligned", () => {
    const opt = buildAgentOptions([PI], null)[0];
    expect(opt?.icon).toBeDefined();
  });
  it("an enabled option omits the 'reason' key entirely", () => {
    const opt = buildAgentOptions([PI], null)[0];
    expect(opt && "reason" in opt).toBe(false);
  });

  it("reason precedence: not-installed beats every later refusal", () => {
    // Broken AND disabled AND on an offline node — the reader's first fact is
    // that the instance does not even hold the plugin.
    const p = plugin({ id: "x", name: "X", installed: false, enabled: false, broken: "bad entry" });
    const offline = node({ id: "a2", status: "offline" });
    expect(buildAgentOptions([p], offline)[0]?.reason).toBe("not installed on this server");
  });
  it("reason precedence: failed-to-load beats disabled and node reasons", () => {
    const p = plugin({ id: "x", name: "X", broken: "missing entry file", enabled: false });
    const offline = node({ id: "a2", status: "offline" });
    expect(buildAgentOptions([p], offline)[0]?.reason).toBe("failed to load");
  });
  it("reason precedence: disabled beats the node reasons", () => {
    const p = plugin({ id: "x", name: "X", enabled: false });
    const offline = node({ id: "a2", status: "offline" });
    expect(buildAgentOptions([p], offline)[0]?.reason).toBe("disabled on this server");
  });

  it("an offline node reasons 'node offline'", () => {
    const offline = node({ id: "a2", status: "offline" });
    expect(buildAgentOptions([PI], offline)[0]?.reason).toBe("node offline");
  });
  it("a node without the plugin reasons 'not installed on this node'", () => {
    const bare = node({ id: "a1", name: "bare", harnesses: [] });
    // toMatchObject, not toEqual: every agent option now also carries an
    // icon node, which this case is not about.
    expect(buildAgentOptions([PI], bare)[0]).toMatchObject({
      value: "pi",
      label: "Pi",
      disabled: true,
      reason: "not installed on this node",
    });
  });
  it("a stale inventory makes 'not installed on this node' honest as last-known", () => {
    const stale = node({ harnesses: [], inventoryStale: true });
    expect(buildAgentOptions([PI], stale)[0]?.reason).toBe("not installed on this node (inventory may be outdated)");
  });
  it("the server-side checks hold with NO node picked", () => {
    const absent = buildAgentOptions([plugin({ id: "u", name: "U", installed: false })], null)[0];
    expect(absent?.disabled).toBe(true);
    expect(absent?.reason).toBe("not installed on this server");
  });

  it("puts what can be launched first, keeping the caller's order within each group", () => {
    // The report this came from (2026-09-11): on a fresh machine the picker
    // put the one selectable row sixth, under a wall of greyed rows. The
    // reasons still show; they sit under the rows a hand can land on.
    const plugins = [
      plugin({ id: "codex", name: "Codex" }),
      plugin({ id: "claude-code", name: "Claude Code" }),
      PI,
      TERM,
    ];
    expect(buildAgentOptions(plugins, HERE).map((o) => [o.value, o.disabled])).toEqual([
      ["claude-code", false],
      ["codex", true],
      ["pi", true],
      ["terminal", true],
    ]);
  });
});

describe("defaultAgentId", () => {
  const HERE = node({
    id: "local",
    kind: "local",
    harnesses: [CLAUDE_ON, { harnessId: "pi", name: "Pi", installed: true }],
  });

  it("takes the most recent subshell's agent when it is still usable", () => {
    const plugins = [CLAUDE, PI];
    const options = buildAgentOptions(plugins, HERE);
    expect(defaultAgentId(options, plugins, "pi")).toBe("pi");
  });
  it("an unusable recent agent does not hold the default", () => {
    const plugins = [CLAUDE, plugin({ id: "gone", name: "Gone", installed: false })];
    const options = buildAgentOptions(plugins, HERE);
    expect(defaultAgentId(options, plugins, "gone")).toBe("claude-code");
  });
  it("falls to the first usable NON-terminal agent even when Terminal ranks first", () => {
    // The default rule of spec 2026-09-13 §5: a plain shell is a fallback,
    // not the headline, whatever order the catalog happens to arrive in.
    // (Both usable here: no node, so nothing greys.)
    const plugins = [TERM, CLAUDE];
    expect(defaultAgentId(buildAgentOptions(plugins, null), plugins, null)).toBe("claude-code");
  });
  it("a plugin with no type reads as an agent, not a terminal", () => {
    // Older payload without the field: nothing is deprioritized.
    const plugins = [plugin({ id: "mystery", name: "Mystery" })];
    expect(defaultAgentId(buildAgentOptions(plugins, null), plugins, null)).toBe("mystery");
  });
  it("when only Terminal is usable, Terminal is the default", () => {
    const plugins = [plugin({ id: "claude-code", name: "Claude Code", installed: false }), TERM];
    expect(defaultAgentId(buildAgentOptions(plugins, null), plugins, null)).toBe("terminal");
  });
  it("null when nothing is usable — and on an empty catalog", () => {
    const plugins = [plugin({ id: "x", name: "X", installed: false })];
    expect(defaultAgentId(buildAgentOptions(plugins, HERE), plugins, null)).toBeNull();
    expect(defaultAgentId([], [], null)).toBeNull();
  });
});

describe("buildNodeOptions", () => {
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

  it("without an agent, only offline agents are disabled and labels carry the platform", () => {
    const opts = buildNodeOptions([LOCAL, AGENT], null);
    expect(opts[0]).toEqual({ value: "local", label: "Server · linux/x64", disabled: false });
    expect(opts[1]).toEqual({ value: "a1", label: "mac-mini", disabled: false });
  });
  it("a chosen agent greys nodes lacking it, named by DISPLAY name", () => {
    const [localOpt, agentOpt] = buildNodeOptions([LOCAL, AGENT], CLAUDE);
    expect(localOpt?.disabled).toBe(false);
    expect(agentOpt).toEqual({ value: "a1", label: "mac-mini", disabled: true, reason: "no Claude Code here" });
  });
  it("a stale inventory hedges the node-side missing-agent reason", () => {
    const stale = node({ id: "a9", name: "ghost", harnesses: [], inventoryStale: true });
    expect(buildNodeOptions([stale], CLAUDE)[0]?.reason).toBe("no Claude Code here (inventory may be outdated)");
  });
  it("selectable nodes come first, in the caller's order", () => {
    const offline = node({ id: "a2", name: "old", status: "offline", harnesses: [CLAUDE_ON] });
    const opts = buildNodeOptions([offline, LOCAL, AGENT], CLAUDE);
    // LOCAL runs Claude Code; AGENT declares nothing and `old` is offline.
    expect(opts.map((o) => [o.value, o.disabled])).toEqual([
      ["local", false],
      ["a2", true],
      ["a1", true],
    ]);
  });
  it("greys a node in maintenance and says why, rather than dropping it", () => {
    // It is the one unlaunchable row that stays in the list, so the option
    // owes the reader both the word on the label and the reason beside it.
    const maint = node({ id: "m1", name: "shop", harnesses: [CLAUDE_ON], maintenance: true });
    const [opt] = buildNodeOptions([maint], CLAUDE);
    expect(opt).toEqual({ value: "m1", label: "shop (maintenance)", disabled: true, reason: "in maintenance" });
  });

  it("does not stack a maintenance reason on a node whose label already says offline", () => {
    // Offline carries no reason text — the label's last segment is the whole
    // explanation — and a machine that is both would otherwise read as if
    // ending maintenance made it usable.
    const both = node({ id: "m2", name: "shop", status: "offline", harnesses: [CLAUDE_ON], maintenance: true });
    const [opt] = buildNodeOptions([both], CLAUDE);
    expect(opt).toEqual({ value: "m2", label: "shop (offline) (maintenance)", disabled: true });
  });

  it("an offline agent stays disabled with the offline label and no reason text", () => {
    const opts = buildNodeOptions([node({ id: "a2", name: "old", status: "offline", harnesses: [CLAUDE_ON] })], CLAUDE);
    expect(opts[0]).toEqual({ value: "a2", label: "old (offline)", disabled: true });
  });
});

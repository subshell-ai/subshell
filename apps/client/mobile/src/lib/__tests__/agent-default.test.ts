import { describe, expect, it } from "bun:test";
import { agentDefault, defaultAgentId, mostRecentHarnessId } from "@/lib/agent-default";
import type { PluginView } from "@/types/plugin";

/** Minimal PluginView factory — the rule reads installed/enabled/broken/type. */
function plugin(over: Partial<PluginView> = {}): PluginView {
  return {
    id: "p",
    name: "P",
    type: "agent-harness",
    description: "",
    installed: true,
    enabled: true,
    ...over,
  };
}

const ALL_INSTALLED = () => true;

describe("defaultAgentId", () => {
  const CLAUDE = plugin({ id: "claude-code", name: "Claude Code" });
  const CODEX = plugin({ id: "codex", name: "Codex" });
  const TERMINAL = plugin({ id: "terminal", name: "Terminal", type: "terminal" });

  it("picks the recent harness while it stays usable", () => {
    expect(defaultAgentId([CLAUDE, CODEX], ALL_INSTALLED, "codex")).toBe("codex");
  });

  it("a recent harness that is not usable falls through to the default rule", () => {
    const dead = plugin({ id: "old", name: "Old", installed: false });
    expect(defaultAgentId([CLAUDE, dead], ALL_INSTALLED, "old")).toBe("claude-code");
    // …and the same for disabled, broken, and a foreign recent id.
    const off = plugin({ id: "old", name: "Old", enabled: false });
    expect(defaultAgentId([CLAUDE, off], ALL_INSTALLED, "old")).toBe("claude-code");
    const broken = plugin({ id: "old", name: "Old", broken: "failed to load" });
    expect(defaultAgentId([CLAUDE, broken], ALL_INSTALLED, "old")).toBe("claude-code");
    expect(defaultAgentId([CLAUDE], ALL_INSTALLED, "nonexistent")).toBe("claude-code");
  });

  it("a recent harness usable on the instance but blocked on the node is not usable", () => {
    const onNode = (id: string) => id !== "codex";
    expect(defaultAgentId([CLAUDE, CODEX], onNode, "codex")).toBe("claude-code");
    expect(defaultAgentId([CLAUDE, CODEX], ALL_INSTALLED, "codex")).toBe("codex");
  });

  it("prefers the first usable non-terminal over a terminal listed first", () => {
    expect(defaultAgentId([TERMINAL, CLAUDE, CODEX], ALL_INSTALLED, null)).toBe("claude-code");
  });

  it("a missing type (older server) is still pickable, but no longer outranks a declared agent", () => {
    // The middle tier reads `=== "agent-harness"` rather than
    // `!== "terminal"` now, because a third type exists (network) and an
    // exclusion admitted it. The cost is exactly this: an untyped row loses
    // the first tier. It keeps the "anything usable" fallback, so nothing
    // becomes unpickable.
    const legacy: PluginView = { id: "legacy", name: "Legacy", description: "", installed: true, enabled: true };
    expect(defaultAgentId([TERMINAL, legacy], ALL_INSTALLED, null)).toBe("terminal");
    expect(defaultAgentId([legacy], ALL_INSTALLED, null)).toBe("legacy");
    expect(defaultAgentId([legacy, CLAUDE], ALL_INSTALLED, null)).toBe("claude-code");
  });

  it("never picks a network plugin — it drives no pane", () => {
    const net = plugin({ id: "tailscale", name: "Tailscale", type: "network" });
    expect(defaultAgentId([net, CLAUDE], ALL_INSTALLED, null)).toBe("claude-code");
    // Last resort included: a catalog of nothing but networks fills nothing.
    // (The chips never see one either — `hooks/use-plugins.ts` filters them
    // out of the catalog, because there is no screen on a phone where a
    // network belongs.)
    expect(defaultAgentId([net], ALL_INSTALLED, null)).toBeNull();
    // Not even as the RECENT pick, which is the one tier that bypasses the
    // ordering: a subshell's harness id can never be a network's, but the
    // rule must not be the thing that assumes it.
    expect(defaultAgentId([net], ALL_INSTALLED, "tailscale")).toBeNull();
  });

  it("falls back to the terminal when it is all that is usable", () => {
    const offClaude = plugin({ id: "claude-code", name: "Claude Code", installed: false });
    expect(defaultAgentId([offClaude, TERMINAL], ALL_INSTALLED, null)).toBe("terminal");
  });

  it("node-blocked agents never win the non-terminal pick", () => {
    // Codex is first in id order but not on this node; Terminal must not win
    // over the usable agent that comes later.
    expect(defaultAgentId([CODEX, CLAUDE, TERMINAL], (id) => id === "claude-code", null)).toBe("claude-code");
  });

  it("returns null when nothing is usable", () => {
    expect(defaultAgentId([], ALL_INSTALLED, null)).toBeNull();
    const nothing = [plugin({ id: "a", installed: false }), plugin({ id: "b", enabled: false })];
    expect(defaultAgentId(nothing, ALL_INSTALLED, null)).toBeNull();
    expect(defaultAgentId([CLAUDE], () => false, "claude-code")).toBeNull();
  });
});

describe("agentDefault — the cold-start gate (ruled 2026-09-13)", () => {
  const CLAUDE = plugin({ id: "claude-code", name: "Claude Code" });
  const CODEX = plugin({ id: "codex", name: "Codex" });
  const TERMINAL = plugin({ id: "terminal", name: "Terminal", type: "terminal" });
  const at = (harnessId: string, createdAt: string) => ({ harnessId, createdAt });

  it("no fill while the subshells list has not answered", () => {
    // Pending (or errored dataless) — the query's data is undefined, and
    // load timing must not choose the default agent.
    expect(agentDefault([CLAUDE, CODEX], ALL_INSTALLED, undefined)).toBeNull();
    // Same while plugins are still loading.
    expect(agentDefault(undefined, ALL_INSTALLED, [])).toBeNull();
  });

  it("settled-then-EMPTY answers through the first-usable tier", () => {
    // An empty list is a real answer: recent is null, the ordinary rule stands.
    expect(agentDefault([TERMINAL, CLAUDE], ALL_INSTALLED, [])).toBe("claude-code");
  });

  it("settled list honors the recent tier", () => {
    const rows = [at("claude-code", "2026-09-10T00:00:00.000Z"), at("codex", "2026-09-12T00:00:00.000Z")];
    expect(agentDefault([CLAUDE, CODEX], ALL_INSTALLED, rows)).toBe("codex");
  });
});

describe("mostRecentHarnessId", () => {
  const at = (harnessId: string, createdAt: string) => ({ harnessId, createdAt });

  it("null for an empty list", () => {
    expect(mostRecentHarnessId([])).toBeNull();
  });

  it("picks the newest by createdAt regardless of input order", () => {
    const rows = [
      at("codex", "2026-09-10T00:00:00.000Z"),
      at("claude-code", "2026-09-12T00:00:00.000Z"),
      at("terminal", "2026-09-11T00:00:00.000Z"),
    ];
    expect(mostRecentHarnessId(rows)).toBe("claude-code");
    expect(mostRecentHarnessId([...rows].reverse())).toBe("claude-code");
  });

  it("a tie keeps the first-encountered (strict newer-wins)", () => {
    const T = "2026-09-12T00:00:00.000Z";
    expect(mostRecentHarnessId([at("a", T), at("b", T)])).toBe("a");
  });
});

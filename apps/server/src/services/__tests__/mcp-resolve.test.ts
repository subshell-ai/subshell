import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  MCP_LAUNCH_PLACEHOLDER,
  type McpProbeOutcome,
  probeMcpLaunch,
  resolveMcpLaunch,
} from "@/services/mcp-resolve.js";

/**
 * The pure launch RESOLVER for `subshell mcp` (extracted from mcp-launch.ts so
 * the side-effect-free CLI `status` can import it). Since spec 2026-09-03 the
 * ladder is: env override → SELF (`subshell-server mcp` — the server binary IS
 * the MCP server) → `subshell`-on-PATH (hosts predating the self rung). The
 * compiled-sibling and dist-entry rungs are retired with the companion
 * artifact; the fakes below pin every remaining seam (`execPath`, `argv1`,
 * `which` — `exists` is gone, no rung touches the fs anymore).
 */

/** Io seams where PATH is empty and there is no usable script/entry — every autodetect rung misses. */
const NOTHING = { which: () => null, execPath: "/usr/local/bin/bun", argv1: "" };

/** Narrow a probe to its rung name, failing the test with the error text when unresolved. */
function resolvedSource(probe: McpProbeOutcome): string {
  if (probe.spec) return probe.source;
  throw new Error(`probe did not resolve: ${probe.error}`);
}

describe("probeMcpLaunch", () => {
  it("honors SUBSHELL_MCP_COMMAND + SUBSHELL_MCP_ARGS above all autodetection", () => {
    const probe = probeMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp", SUBSHELL_MCP_ARGS: '["a","b"]' }, NOTHING);
    expect(probe).toEqual({ spec: { command: "/opt/custom/mcp", args: ["a", "b"] }, source: "env" });
  });

  it("SUBSHELL_MCP_COMMAND alone means an empty argv", () => {
    const probe = probeMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp" }, NOTHING);
    expect(probe.spec).toEqual({ command: "/opt/custom/mcp", args: [] });
  });

  it("a malformed SUBSHELL_MCP_ARGS is a probe ERROR, never a throw (status keeps sync-exit)", () => {
    // The operator-typo shape: a bare `mcp` instead of `["mcp"]`. An
    // unguarded JSON.parse here would suspend the entry mid-`status` — the
    // litter scenario pinned in cli-entry.test.ts.
    const probe = probeMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp", SUBSHELL_MCP_ARGS: "mcp" }, NOTHING);
    expect(probe.spec).toBeNull();
    expect(probe.error).toContain("SUBSHELL_MCP_ARGS");
    // JSON that parses but isn't an array is the same class of typo.
    const notArray = probeMcpLaunch({ SUBSHELL_MCP_COMMAND: "/x", SUBSHELL_MCP_ARGS: '{"a":1}' }, NOTHING);
    expect(notArray.spec).toBeNull();
    expect(notArray.error).toContain("SUBSHELL_MCP_ARGS");
  });

  it("self (compiled): the server binary re-invokes itself with mcp", () => {
    const probe = probeMcpLaunch({}, { execPath: "/srv/bin/subshell-server", which: () => null });
    expect(probe).toEqual({ spec: { command: "/srv/bin/subshell-server", args: ["mcp"] }, source: "self" });
  });

  it("self (compiled, triple-suffixed): the release artifact name still self-resolves", () => {
    const probe = probeMcpLaunch({}, { execPath: "/srv/bin/subshell-server-darwin-arm64", which: () => null });
    expect(resolvedSource(probe)).toBe("self");
  });

  it("self (bun-interpreted): absolute entry + mcp argv — safe from any pane cwd", () => {
    const probe = probeMcpLaunch({}, { execPath: "/usr/local/bin/bun", argv1: "dist/index.js", which: () => null });
    expect(resolvedSource(probe)).toBe("self");
    expect(probe.spec?.args[0]).toBe(join(process.cwd(), "dist/index.js"));
    expect(probe.spec?.args[1]).toBe("mcp");
  });

  it("bun-interpreted without a usable argv1 skips self (never bake a bogus entry)", () => {
    const probe = probeMcpLaunch({}, { execPath: "/usr/local/bin/bun", argv1: "", which: () => null });
    expect(probe.spec).toBeNull();
  });

  it("compiled-shape rename: a $bunfs virtual argv1 is NOT an entry — fall through, never (via self)", () => {
    // B1: a COMPILED Bun binary sets argv[1] to a virtual `/$bunfs/root/...`
    // path. When the artifact is renamed so its basename misses the
    // `subshell-server` gate, the argv1 rung must not bake the unspawnable
    // `<renamed-bin> /$bunfs/... mcp` and report `(via self)` — it must fall
    // through to client-on-PATH and, with no agent, to the UNRESOLVED error.
    const probe = probeMcpLaunch(
      {},
      { execPath: "/srv/bin/srv", argv1: "/$bunfs/root/subshell-server-darwin-arm64", which: () => null },
    );
    expect(probe.spec).toBeNull();
    expect(probe.error).toContain("SUBSHELL_MCP_COMMAND");
  });

  it("extensionless argv1 (a wrapper script) also skips self", () => {
    // The rung exists for `bun <entry>.ts|js` shapes only: whatever a
    // non-entry argv[1] names (wrapper, shebang script), baking it would
    // spawn a process that is not the MCP server.
    const probe = probeMcpLaunch(
      {},
      { execPath: "/usr/local/bin/bun", argv1: "/usr/local/bin/wrapper", which: () => null },
    );
    expect(probe.spec).toBeNull();
  });

  it("client-on-PATH remains the last rung", () => {
    const probe = probeMcpLaunch(
      {},
      {
        execPath: "/usr/local/bin/bun",
        argv1: "",
        which: (n) => (n === "subshell" ? "/usr/local/bin/subshell" : null),
      },
    );
    expect(probe).toEqual({ spec: { command: "/usr/local/bin/subshell", args: ["mcp"] }, source: "client-on-path" });
  });

  it("a bare `subshell` on PATH never beats the self rung", () => {
    const probe = probeMcpLaunch({}, { execPath: "/srv/subshell-server", which: () => "/usr/bin/subshell", argv1: "" });
    expect(resolvedSource(probe)).toBe("self");
  });

  it("a `subshell` on PATH never shadows the bun-interpreted self rung either", () => {
    // Dev shape under a host with the node agent installed: plain bun + a
    // usable argv[1] must self-resolve BEFORE the PATH rung is consulted.
    const probe = probeMcpLaunch(
      {},
      { execPath: "/usr/bin/bun", argv1: "src/index.ts", which: () => "/usr/bin/subshell" },
    );
    expect(resolvedSource(probe)).toBe("self");
    expect(probe.spec?.command).toBe("/usr/bin/bun");
  });

  it("nothing resolves: probe reports the error, resolveMcpLaunch throws it", () => {
    const probe = probeMcpLaunch({}, NOTHING);
    expect(probe.spec).toBeNull();
    expect(probe.error).toContain("SUBSHELL_MCP_COMMAND");
    expect(() => resolveMcpLaunch({}, NOTHING)).toThrow(/SUBSHELL_MCP_COMMAND/);
  });

  it("in-repo autodetection resolves via the self rung (bun-interpreted shape)", () => {
    // `bun test` rewrites process.argv[1] to a TEST FILE, not a server entry —
    // pin the in-repo launch shape (`bun src/index.ts`) instead of leaning on
    // ambient argv1. No other seam is faked: no rung touches the fs or PATH
    // before self answers, so this is the real dev/boot-path resolution.
    const probe = probeMcpLaunch({}, { argv1: "src/index.ts" });
    expect(probe).toEqual(expect.objectContaining({ source: "self" }));
    expect(probe.spec?.command).toBe(process.execPath);
    expect(probe.spec?.args).toEqual([join(process.cwd(), "src/index.ts"), "mcp"]);
  });
});

describe("resolveMcpLaunchForDisplay / placeholder", () => {
  it("never throws; the unresolved-fallback constant names the real self command", () => {
    // Pins the fallback CONSTANT (the catch branch's value, unforceable from
    // tests): it must name a command a current deployment actually runs
    // (`subshell-server mcp`, spec 2026-09-03). An invented name once shipped
    // here and would have poisoned every operator's manual registration.
    expect(resolveMcpLaunch({})).toBeDefined();
    expect(MCP_LAUNCH_PLACEHOLDER).toEqual({ command: "subshell-server", args: ["mcp"] });
  });
});

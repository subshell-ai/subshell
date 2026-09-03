import { describe, expect, it } from "bun:test";
import { MCP_LAUNCH_PLACEHOLDER, probeMcpLaunch, resolveMcpLaunch } from "@/services/mcp-resolve.js";

/**
 * The pure launch RESOLVER for `subshell mcp` (extracted from mcp-launch.ts so
 * the side-effect-free CLI `status` can import it). The ladders below pin every
 * rung by faking the fs/PATH/executable seams — the shape of real deployments
 * is: env override (exotic), compiled sibling (dev `compile`), dist entry
 * (plain `tsc` builds), client-on-PATH (standalone release binary + the
 * enrolled `subshell` agent, the shape that 500'd on mac-builder before
 * SUBSHELL_MCP_COMMAND existed as the only escape).
 */

/** Io seams where NOTHING exists and PATH is empty — every autodetect rung misses. */
const NOTHING = { exists: () => false, which: () => null, execPath: "/usr/local/bin/bun" };

describe("probeMcpLaunch", () => {
  it("honors SUBSHELL_MCP_COMMAND + SUBSHELL_MCP_ARGS above all autodetection", () => {
    const probe = probeMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp", SUBSHELL_MCP_ARGS: '["a","b"]' }, NOTHING);
    expect(probe).toEqual({ spec: { command: "/opt/custom/mcp", args: ["a", "b"] }, source: "env" });
  });

  it("SUBSHELL_MCP_COMMAND alone means an empty argv", () => {
    const probe = probeMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp" }, NOTHING);
    expect(probe.spec).toEqual({ command: "/opt/custom/mcp", args: [] });
  });

  it("compiled sibling: a subshell-mcp beside the subshell-server executable", () => {
    const probe = probeMcpLaunch(
      {},
      {
        execPath: "/srv/bin/subshell-server",
        exists: (p) => p === "/srv/bin/subshell-mcp",
        which: () => null,
      },
    );
    expect(probe).toEqual({ spec: { command: "/srv/bin/subshell-mcp", args: [] }, source: "compiled-sibling" });
  });

  it("the triple-suffixed release name still finds the sibling", () => {
    const probe = probeMcpLaunch(
      {},
      {
        execPath: "/srv/bin/subshell-server-darwin-arm64",
        exists: (p) => p === "/srv/bin/subshell-mcp",
        which: () => null,
      },
    );
    expect(probe).toEqual(expect.objectContaining({ source: "compiled-sibling" }));
  });

  it("the pre-rename `backend` executable name is NOT special-cased anymore", () => {
    // A sibling beside an unrelated `backend` binary must NOT resolve — the
    // old rung matched this name; the rename to subshell-server made it dead.
    const probe = probeMcpLaunch(
      {},
      {
        execPath: "/srv/bin/backend",
        exists: (p) => p === "/srv/bin/subshell-mcp",
        which: () => null,
      },
    );
    expect(probe.spec).toBeNull();
  });

  it("dist entry: the sibling mcp main beside this module (plain tsc dist / dev src)", () => {
    const probe = probeMcpLaunch(
      {},
      {
        ...NOTHING,
        exists: (p) => p.endsWith("/mcp/main.js") || p.endsWith("/mcp/main.ts"),
      },
    );
    expect(probe).toEqual(expect.objectContaining({ source: "dist-entry" }));
    expect(probe.spec?.command).toBe("/usr/local/bin/bun");
    expect(probe.spec?.args[0]).toMatch(/\/mcp\/main\.(js|ts)$/);
  });

  it("client-on-PATH: the standalone binary falls back to the `subshell` agent's mcp", () => {
    // The mac-builder shape: compiled server (no dist, no sibling) on a host
    // where the enrolled client binary carries the same mcp-core server.
    const probe = probeMcpLaunch(
      {},
      {
        execPath: "/Users/theo/.local/bin/subshell-server",
        exists: () => false,
        which: (name) => (name === "subshell" ? "/Users/theo/.local/bin/subshell" : null),
      },
    );
    expect(probe).toEqual({
      spec: { command: "/Users/theo/.local/bin/subshell", args: ["mcp"] },
      source: "client-on-path",
    });
  });

  it("dist entry WINS over the client on PATH (never hijack a plain-dist deploy)", () => {
    const probe = probeMcpLaunch(
      {},
      {
        execPath: "/usr/local/bin/bun",
        exists: (p) => p.endsWith("/mcp/main.js"),
        which: (name) => (name === "subshell" ? "/usr/local/bin/subshell" : null),
      },
    );
    expect(probe).toEqual(expect.objectContaining({ source: "dist-entry" }));
  });

  it("nothing resolves: probe reports the error, resolveMcpLaunch throws it", () => {
    const probe = probeMcpLaunch({}, NOTHING);
    expect(probe.spec).toBeNull();
    expect(probe.error).toContain("SUBSHELL_MCP_COMMAND");
    expect(() => resolveMcpLaunch({}, NOTHING)).toThrow(/SUBSHELL_MCP_COMMAND/);
  });

  it("in-repo autodetection succeeds with real seams (dist-entry rung, live fs)", () => {
    const probe = probeMcpLaunch({});
    expect(probe.spec).not.toBeNull();
    expect(probe).toEqual(expect.objectContaining({ source: "dist-entry" }));
  });
});

describe("resolveMcpLaunchForDisplay / placeholder", () => {
  it("never throws; the unresolved-fallback constant names a real artifact", () => {
    // Pins the fallback CONSTANT (the catch branch's value, unforceable from
    // tests): it must name something this repo actually ships (`subshell-mcp`,
    // via bun run compile). An invented `subshell mcp` subcommand once shipped
    // here and would have poisoned every operator's manual registration.
    expect(resolveMcpLaunch({})).toBeDefined();
    expect(MCP_LAUNCH_PLACEHOLDER).toEqual({ command: "subshell-mcp", args: [] });
  });
});

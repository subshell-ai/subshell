import { describe, expect, it } from "bun:test";
import { sshPaneSummary } from "@/services/subshell-manager.service.js";

/**
 * The bounded ssh view the pane header reads (spec 2026-10-15 §6): what the
 * column holds, nothing more, and never a throw over unreadable bytes.
 */
const column = {
  alias: "build",
  host: "build.example",
  user: "theo",
  port: 22,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: [],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  // The config-derived refusal marker stays null; declared rows are the
  // sibling key, and the summary reads only that one.
  forwards: null,
  tunnels: null,
};

describe("sshPaneSummary", () => {
  it("names the canonical destination and lists the declared rows", () => {
    const summary = sshPaneSummary(
      JSON.stringify({
        ...column,
        declaredForwards: [
          { kind: "local", listenPort: 5432, bindHost: null, targetHost: "db.internal", targetPort: 5432 },
          { kind: "dynamic", listenPort: 1080, bindHost: null, targetHost: null, targetPort: null },
        ],
      }),
    );
    expect(summary?.destination).toBe("theo@build.example:22");
    expect(summary?.forwards).toEqual([
      { kind: "local", listenPort: 5432, bindHost: null, targetHost: "db.internal", targetPort: 5432 },
      { kind: "dynamic", listenPort: 1080, bindHost: null, targetHost: null, targetPort: null },
    ]);
  });

  it("omits the user when the connection used the account default", () => {
    expect(sshPaneSummary(JSON.stringify({ ...column, user: null }))?.destination).toBe("build.example:22");
  });

  it("an ssh pane that declared nothing has an empty list, not a missing summary", () => {
    const summary = sshPaneSummary(JSON.stringify(column));
    expect(summary?.destination).toBe("theo@build.example:22");
    expect(summary?.forwards).toEqual([]);
  });

  it("yields nothing for bytes a list must not trip over", () => {
    expect(sshPaneSummary(null)).toBeNull();
    expect(sshPaneSummary("{oops")).toBeNull();
    expect(sshPaneSummary("[1,2]")).toBeNull();
    // A column without the destination facts (a fixture, a future shape) shows
    // no half-built line.
    expect(sshPaneSummary(JSON.stringify({ destination: "dev.example.com" }))).toBeNull();
  });

  it("keeps the destination when a stored row list fails its grammar", () => {
    // A header is not where a stored-row bug gets surfaced: the destination
    // still earned its place, and the broken list is WITHHELD as null - never
    // folded into [], because [] is the claim that no ports were opened.
    const summary = sshPaneSummary(JSON.stringify({ ...column, declaredForwards: [{ kind: "sideways" }] }));
    expect(summary?.destination).toBe("theo@build.example:22");
    expect(summary?.forwards).toBeNull();
  });
});

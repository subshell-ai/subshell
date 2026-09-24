import { describe, expect, it } from "bun:test";
import { planRemoteSubshellMcp } from "@/services/mcp-launch.js";
import type { NodeFacts } from "@/services/nodes/node-registry.js";
import { NoLiveConnectionError, RemoteLauncher } from "@/services/nodes/remote-launcher.js";

/**
 * The backend half of the node-path id gate (audit 2026-09, item 7). The
 * agent has always checked `isNodeSubshellId` before interpolating an id into
 * a path; since 2026-09-23 the plane checks the same guard at its own
 * composition sites, so "a hostile `../../../../x` never reaches path
 * interpolation" is true on BOTH sides of the link rather than true by the
 * accident that every id today is a server-minted uuid.
 */

const LIVE_FACTS = {
  dataDir: "/var/lib/subshell",
  capabilities: [],
  hostname: "box",
  agentVersion: "9.9.9",
} as unknown as NodeFacts;

/** Ids whose shape could escape the template if they ever reached it. */
const HOSTILE = ["../../etc/passwd", "a/b", "id\x00.log", "x".repeat(65), "UP/../PERM", ""];

function online(): RemoteLauncher {
  return new RemoteLauncher("n1", { facts: () => LIVE_FACTS });
}

describe("RemoteLauncher path composition refuses non-conforming ids", () => {
  for (const id of HOSTILE) {
    it(`logPath/metaArtifactPath/mcpArtifactPath/subshellArtifacts all refuse ${JSON.stringify(id)}`, () => {
      const launcher = online();
      expect(() => launcher.logPath(id)).toThrow(/subshell id/);
      expect(() => launcher.metaArtifactPath(id)).toThrow(/subshell id/);
      expect(() => launcher.mcpArtifactPath(id)).toThrow(/subshell id/);
      // The delete-time sweep shares the guard THROUGH the three methods it
      // composes — there is no fourth interpolation to forget.
      expect(() => launcher.subshellArtifacts(id)).toThrow(/subshell id/);
    });
  }

  it("refuses BEFORE any other question — even a dead refusal is not the offline throw", () => {
    // Offline, a valid id gets NoLiveConnectionError (the sentinel the create
    // path maps to 409). A hostile id must NOT be laundered into that
    // user-facing answer: the invariant is about the id, and it is checked
    // first, on an offline launcher too.
    const offline = new RemoteLauncher("n1", { facts: () => undefined });
    expect(() => offline.logPath("../../etc/passwd")).toThrow(/subshell id/);
    try {
      offline.logPath("../../etc/passwd");
    } catch (err) {
      expect(err).not.toBeInstanceOf(NoLiveConnectionError);
    }
    expect(() => offline.logPath("9a3b1c2d-0000-4000-8000-000000000000")).toThrow(NoLiveConnectionError);
  });

  it("a conforming uuid still composes the documented template", () => {
    const id = "9a3b1c2d-0000-4000-8000-000000000000";
    const launcher = online();
    expect(launcher.logPath(id)).toBe(`/var/lib/subshell/subshells/${id}.log`);
    expect(launcher.metaArtifactPath(id)).toBe(`/var/lib/subshell/subshells/${id}.meta.json`);
    expect(launcher.mcpArtifactPath(id)).toBe(`/var/lib/subshell/mcp/${id}.json`);
    expect(launcher.subshellArtifacts(id)).toEqual([
      `/var/lib/subshell/subshells/${id}.log`,
      `/var/lib/subshell/mcp/${id}.json`,
      `/var/lib/subshell/subshells/${id}.meta.json`,
    ]);
  });
});

/**
 * The launch-side twin. `planRemoteSubshellMcp` composes the SAME
 * `<dataDir>/mcp/<id>.json` template the delete-side `mcpArtifactPath`
 * duplicates (the duplicate is a pinned cycle-break, not laziness), so it
 * shares the guard through the same leaf module rather than growing a second
 * ungated interpolation.
 */
describe("planRemoteSubshellMcp refuses a non-conforming id at its composition site", () => {
  const harness = {
    id: "claude-code",
    mcpRegistration: (_launch: unknown, path: string) => ({ argv: [], env: {}, filePath: path }),
  } as unknown as Parameters<typeof planRemoteSubshellMcp>[0];

  it("hostile id throws before the frame is built", () => {
    expect(() => planRemoteSubshellMcp(harness, "../../etc/passwd", { dataDir: "/d" })).toThrow(/subshell id/);
  });

  it("a conforming uuid still composes the template", () => {
    const id = "9a3b1c2d-0000-4000-8000-000000000000";
    const planned = planRemoteSubshellMcp(harness, id, { dataDir: "/d" });
    expect(planned?.configPath).toBe(`/d/mcp/${id}.json`);
  });
});

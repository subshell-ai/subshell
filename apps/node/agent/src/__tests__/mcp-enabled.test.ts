import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeCommandBody, NodeEvent } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { maybeReportMcpEnabled, seedMcpEnabledMemo } from "../commands/report.js";
import type { NodeConfig } from "../config.js";
import { mcpAllowed, mcpEnabledPath, readMcpEnabled, reportableMcpEnabled, writeMcpEnabled } from "../mcp-enabled.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The MCP-use mirror, whose family is `ssh-enabled.ts` and `preview/flags.ts`
 * and whose DEFAULT is their inversion: an absent mirror ALLOWS, because MCP
 * wiring predates the switch, and only a parsed `on: false` (or a present file
 * that cannot be trusted) refuses. These cells exist to make each of the four
 * answers, and the silence rules over them, expensive to break by accident:
 * a future edit that folds the off-file into "absent" would un-say every
 * owner's refusal, and one that folds "absent" into "unreadable" would strip
 * cross-agent comms from every node that has never been pushed a value.
 */

const STAMP = "2026-11-01T10:00:00.000Z";
const made: string[] = [];

function freshDataDir(): string {
  // realpath'd like the commands harnesses: macOS hides /private behind the
  // temp dir, and an assertion about the file path should test the path the
  // daemon itself would write.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subshell-mcp-mirror-")));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The mirror's own mtime, as the unreadable branch stamps it. */
function mtimeOf(dataDir: string): string {
  return statSync(mcpEnabledPath(dataDir)).mtime.toISOString();
}

/** A context whose tmux THROWS on anything unstubbed (the ssh harness). */
function makeCtx(dataDir: string, events: NodeEvent[] = []): CommandContext {
  const config: NodeConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const tmux = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("tmux must not be reached");
      },
    },
  );
  return {
    config,
    tmux: tmux as unknown as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => 1_700_000_000_000,
    ws: { send: (ev) => events.push(ev) },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
  };
}

describe("persistence", () => {
  it("an empty dir reads `absent`, and absence is the ALLOWED answer", () => {
    const read = readMcpEnabled(freshDataDir());
    expect(read).toEqual({ kind: "absent" });
    expect(mcpAllowed(read)).toBe(true);
  });

  it("round-trips the exact stamp it was given", () => {
    const dataDir = freshDataDir();
    expect(writeMcpEnabled(dataDir, { on: true, changedAt: STAMP })).toEqual({ on: true, changedAt: STAMP });
    expect(readMcpEnabled(dataDir)).toEqual({ kind: "on", changedAt: STAMP });
  });

  it("stores the whole wire verbatim: `ready.mcpEnabled` is buildable from what was written", () => {
    const dataDir = freshDataDir();
    writeMcpEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(JSON.parse(readFileSync(mcpEnabledPath(dataDir), "utf8"))).toEqual({ on: true, changedAt: STAMP });
  });

  it("keeps `on: false` a VISIBLE kind, not a fold into absent", () => {
    // The preview twin folds its off-file into "absent" because there the two
    // answers coincide (both refuse). Here they do not: absence allows and the
    // off-file refuses, and the refusal must be reportable WITH its stamp, so
    // the kind stands on its own.
    const dataDir = freshDataDir();
    const state = { on: false, changedAt: "2026-11-01T11:00:00.000Z" };
    writeMcpEnabled(dataDir, state);
    expect(JSON.parse(readFileSync(mcpEnabledPath(dataDir), "utf8"))).toEqual(state);
    expect(readMcpEnabled(dataDir)).toEqual({ kind: "off", changedAt: state.changedAt });
  });

  it("writes the file 0600, and creates a missing data dir rather than throwing", () => {
    const dataDir = freshDataDir();
    writeMcpEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(statSync(mcpEnabledPath(dataDir)).mode & 0o777).toBe(0o600);
    const nested = join(freshDataDir(), "nested", "data");
    writeMcpEnabled(nested, { on: true, changedAt: STAMP });
    expect(statSync(mcpEnabledPath(nested)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind, and the file it leaves is whole", () => {
    // Atomic because a half-written file parses as corrupt, and corrupt means
    // REFUSED here, mid-launch.
    const dataDir = freshDataDir();
    writeMcpEnabled(dataDir, { on: true, changedAt: STAMP });
    writeMcpEnabled(dataDir, { on: false, changedAt: "2026-11-01T12:00:00.000Z" });
    expect(readdirSync(dataDir)).toEqual(["mcp-enabled.json"]);
  });
});

describe("a present-but-broken file refuses", () => {
  it("answers `unreadable` for corrupt JSON, carries the file's mtime, and says so once", () => {
    const dataDir = freshDataDir();
    writeFileSync(mcpEnabledPath(dataDir), "{not json");
    const cap = captureLogs();
    try {
      expect(readMcpEnabled(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("mcp-enabled"))).toHaveLength(1);
  });

  it("answers `unreadable` for a well-formed file missing a field, and for a non-boolean on", () => {
    // Same classification the ssh and preview mirrors give garbage: both
    // halves or nothing. `mcpAllowed` then refuses, exactly like a hand-
    // deleted-while-reading ENOENT never does.
    const dataDir = freshDataDir();
    writeFileSync(mcpEnabledPath(dataDir), JSON.stringify({ on: true }));
    const cap = captureLogs();
    try {
      expect(readMcpEnabled(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
      writeFileSync(mcpEnabledPath(dataDir), JSON.stringify({ on: "yes", changedAt: STAMP }));
      expect(readMcpEnabled(dataDir).kind).toBe("unreadable");
    } finally {
      cap.restore();
    }
  });
});

describe("the gate read", () => {
  it("allows absent and on; refuses off and unreadable", () => {
    // The whole inversion of the twin gates, in one table: what a preview
    // mirror answers OFF here is either ALLOWED (absent) or the owner's own
    // deliberate NO (off).
    expect(mcpAllowed({ kind: "absent" })).toBe(true);
    expect(mcpAllowed({ kind: "on", changedAt: STAMP })).toBe(true);
    expect(mcpAllowed({ kind: "off", changedAt: STAMP })).toBe(false);
    expect(mcpAllowed({ kind: "unreadable", changedAt: STAMP })).toBe(false);
  });
});

describe("what a read is worth announcing", () => {
  it("announces `on` verbatim, and `off` too: the refusal is the news", () => {
    expect(reportableMcpEnabled({ kind: "on", changedAt: STAMP })).toEqual({ on: true, changedAt: STAMP });
    expect(reportableMcpEnabled({ kind: "off", changedAt: STAMP })).toEqual({ on: false, changedAt: STAMP });
  });

  it("announces an unreadable mirror as the REFUSAL it produces", () => {
    // The machine owes the plane the answer it is actually acting on, and a
    // row that says on pushes the clean file that repairs the broken one.
    expect(reportableMcpEnabled({ kind: "unreadable", changedAt: STAMP })).toEqual({ on: false, changedAt: STAMP });
  });

  it("sends nothing for absent, and nothing for an unstamped unreadable", () => {
    // Silence reads ALLOWED plane-side, so absence agrees with a default row;
    // an unstamped corruption has no timestamp to carry and inventing `now`
    // would put a frame on the wire every heartbeat, forever.
    expect(reportableMcpEnabled({ kind: "absent" })).toBeUndefined();
    expect(reportableMcpEnabled({ kind: "unreadable" })).toBeUndefined();
  });
});

describe("set_mcp_enabled (the plane's half)", () => {
  it("persists the plane's exact bytes and memoizes them, with no echo and no re-stamp", async () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    const cmd = { type: "set_mcp_enabled", on: true, changedAt: STAMP } satisfies NodeCommandBody;
    expect(await dispatchCommand(ctx, cmd)).toEqual({ ok: true });
    expect(readMcpEnabled(dataDir)).toEqual({ kind: "on", changedAt: STAMP });
    expect(ctx.lastReportedMcpEnabled).toEqual({ on: true, changedAt: STAMP });
    expect(events).toEqual([]); // the command answers with a result; it announces nothing
  });

  it("an off flip lands verbatim, and the machine says nothing more about it", async () => {
    // The push is memoized AS REPORTED: the plane minted this value, so a
    // bounce-back event would only re-tell it what it just said.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    await dispatchCommand(ctx, { type: "set_mcp_enabled", on: false, changedAt: "2026-11-01T13:00:00.000Z" });
    expect(readMcpEnabled(dataDir).kind).toBe("off");
    maybeReportMcpEnabled(ctx);
    expect(events).toEqual([]);
  });
});

describe("the connect seed and the heartbeat belt", () => {
  it("seeds the memo from the mirror and hands `ready` the same value", () => {
    const dataDir = freshDataDir();
    const ctx = makeCtx(dataDir);
    expect(seedMcpEnabledMemo(ctx)).toBeUndefined(); // absent: nothing to state

    writeMcpEnabled(dataDir, { on: false, changedAt: STAMP });
    expect(seedMcpEnabledMemo(ctx)).toEqual({ on: false, changedAt: STAMP });
    expect(ctx.lastReportedMcpEnabled).toEqual({ on: false, changedAt: STAMP });
  });

  it("reports a mirror that moved outside the plane's own push, once", () => {
    // The external-edit case the belt exists to cover: the file is rewritten
    // by hand between commands, and the belt re-reads and re-reports it.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeMcpEnabled(dataDir, { on: true, changedAt: STAMP }); // as a plane push would, memo unmoved

    maybeReportMcpEnabled(ctx);
    maybeReportMcpEnabled(ctx);

    expect(events).toEqual([{ type: "mcp_enabled", on: true, changedAt: STAMP }]);
    expect(ctx.lastReportedMcpEnabled).toEqual({ on: true, changedAt: STAMP });
  });

  it("announces an unreadable mirror once, as the refusal, and repairs nothing itself", () => {
    // The repair is the plane's push (its row wins); a node overwriting its
    // own mirror would make the belt disagree with the row by design.
    const dataDir = freshDataDir();
    writeMcpEnabled(dataDir, { on: true, changedAt: STAMP });
    const ctx = makeCtx(dataDir, []);
    seedMcpEnabledMemo(ctx);
    writeFileSync(mcpEnabledPath(dataDir), "{corrupt");
    const events: NodeEvent[] = [];
    ctx.ws.send = (ev) => events.push(ev);

    const cap = captureLogs();
    try {
      maybeReportMcpEnabled(ctx);
      maybeReportMcpEnabled(ctx);
    } finally {
      cap.restore();
    }
    expect(events).toEqual([{ type: "mcp_enabled", on: false, changedAt: mtimeOf(dataDir) }]);
  });

  it("goes quiet when the mirror simply is not there", () => {
    // Deletion is not an event to announce: silence reads ALLOWED plane-side,
    // and chasing absence with a frame would push noise onto every
    // never-flipped machine. If the row is actually OFF, the belt's silence
    // does not strand it: the next `ready` carries no mirror either, and the
    // reconciler's row-off-plus-silence cell (mcp-enabled.test.ts, the plane
    // suite) pushes the refusal back down. Same-connection divergence is the
    // OS-user's own doing, and that account already owns every pane here.
    const dataDir = freshDataDir();
    const ctx = makeCtx(dataDir);
    writeMcpEnabled(dataDir, { on: false, changedAt: STAMP });
    seedMcpEnabledMemo(ctx);
    rmSync(mcpEnabledPath(dataDir));
    const events: NodeEvent[] = [];
    ctx.ws.send = (ev) => events.push(ev);

    const cap = captureLogs();
    try {
      maybeReportMcpEnabled(ctx);
    } finally {
      cap.restore();
    }
    expect(events).toEqual([]);
  });
});

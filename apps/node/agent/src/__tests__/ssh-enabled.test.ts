import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeCommandBody, NodeEvent } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { maybeReportSshEnabled, seedSshEnabledMemo } from "../commands/report.js";
import type { NodeConfig } from "../config.js";
import { readSshEnabled, reportableSshEnabled, sshAllowed, sshEnabledPath, writeSshEnabled } from "../ssh-enabled.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The SSH-capability mirror (spec 2026-10-07 §4.3): persistence, the
 * file-mode doctrine borrowed from `maintenance.ts`, and the FAIL-CLOSED read
 * — but with the default INVERTED. Maintenance refuses when it reads `on`;
 * this refuses unless it reads `on`, because the plane is the only writer and
 * "never told" is not "allowed" for a widening of egress and keys.
 *
 * The wiring half goes through `dispatchCommand`, so the frame parser and the
 * switch are exercised too (the `commands-maintenance.test.ts` pattern).
 */

const STAMP = "2026-10-07T10:00:00.000Z";
const made: string[] = [];

function freshDataDir(): string {
  // realpath'd like the commands-maintenance harness: macOS hides /private
  // behind the temp dir, and an assertion about the file path should test the
  // path the daemon itself would write.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subshell-ssh-on-")));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The mirror's own mtime, as the unreadable branch stamps it. */
function mtimeOf(dataDir: string): string {
  return statSync(sshEnabledPath(dataDir)).mtime.toISOString();
}

/** A context whose tmux THROWS on anything unstubbed (the maintenance harness). */
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
  it("an empty dir reads `absent`: nothing has said yes, so SSH is refused", () => {
    expect(readSshEnabled(freshDataDir())).toEqual({ kind: "absent" });
  });

  it("round-trips the exact stamp it was given", () => {
    const dataDir = freshDataDir();
    expect(writeSshEnabled(dataDir, { on: true, changedAt: STAMP })).toEqual({ on: true, changedAt: STAMP });
    expect(readSshEnabled(dataDir)).toEqual({ kind: "on", changedAt: STAMP });
  });

  it("stores the whole wire verbatim — `ready.sshEnabled` is buildable from what was written", () => {
    const dataDir = freshDataDir();
    writeSshEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(JSON.parse(readFileSync(sshEnabledPath(dataDir), "utf8"))).toEqual({ on: true, changedAt: STAMP });
  });

  it("stores `on: false` as a value too, but the mirror's ANSWER for it is refusal", () => {
    // The plane stamps the file when it turns SSH off, and the bytes stay on
    // disk; what the reader answers is the gate's answer, and an off file and
    // no file give the same one. There is no node-side writer, so the off
    // stamp is not something anyone later reconciles against — the plane's
    // own row is the record, and it agrees.
    const dataDir = freshDataDir();
    const state = { on: false, changedAt: "2026-10-07T11:00:00.000Z" };
    writeSshEnabled(dataDir, state);
    expect(JSON.parse(readFileSync(sshEnabledPath(dataDir), "utf8"))).toEqual(state);
    expect(readSshEnabled(dataDir)).toEqual({ kind: "absent" });
  });

  it("writes the file 0600, and creates a missing data dir rather than throwing", () => {
    const dataDir = freshDataDir();
    writeSshEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(statSync(sshEnabledPath(dataDir)).mode & 0o777).toBe(0o600);
    const nested = join(freshDataDir(), "nested", "data");
    writeSshEnabled(nested, { on: true, changedAt: STAMP });
    expect(exists(sshEnabledPath(nested))).toBe(true);
  });

  it("leaves no temp file behind, and the file it leaves is whole", () => {
    // Atomic because a half-written file parses as corrupt, and corrupt means
    // REFUSED here — a torn write would cut SSH for the duration of the write.
    const dataDir = freshDataDir();
    writeSshEnabled(dataDir, { on: true, changedAt: STAMP });
    writeSshEnabled(dataDir, { on: false, changedAt: "2026-10-07T12:00:00.000Z" });
    expect(readdirSync(dataDir)).toEqual(["ssh-enabled.json"]);
  });

  function exists(file: string): boolean {
    try {
      statSync(file);
      return true;
    } catch {
      return false;
    }
  }
});

describe("reading is fail-CLOSED", () => {
  it("answers `unreadable` for corrupt JSON, carries the file's mtime, and says so once", () => {
    const dataDir = freshDataDir();
    writeFileSync(sshEnabledPath(dataDir), "{not json");
    const cap = captureLogs();
    try {
      expect(readSshEnabled(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("ssh-enabled"))).toHaveLength(1);
  });

  it("answers `unreadable` for a well-formed file missing a field, and for a non-boolean on", () => {
    // Same classification maintenance gives garbage, and the same reason: both
    // halves or nothing. The brief's unreadable fixtures are content fixtures
    // (a corrupt file) rather than chmod-000 — an EACCES read fails into the
    // same branch, so the three spellings of "cannot read" must not answer
    // differently.
    const dataDir = freshDataDir();
    writeFileSync(sshEnabledPath(dataDir), JSON.stringify({ on: true }));
    const cap = captureLogs();
    try {
      expect(readSshEnabled(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
      writeFileSync(sshEnabledPath(dataDir), JSON.stringify({ on: "yes", changedAt: STAMP }));
      expect(readSshEnabled(dataDir).kind).toBe("unreadable");
    } finally {
      cap.restore();
    }
  });
});

describe("the gate classifier", () => {
  it("allows ONLY a parsed on:true mirror; absent and unreadable both refuse", () => {
    // The whole point of the flag: a node that cannot read its own setting
    // refuses — the opposite of the directory allowlist's deliberate fail-open
    // (spec 2026-10-07 §4.3).
    expect(sshAllowed({ kind: "on", changedAt: STAMP })).toBe(true);
    expect(sshAllowed({ kind: "absent" })).toBe(false);
    expect(sshAllowed({ kind: "unreadable", changedAt: STAMP })).toBe(false);
    expect(sshAllowed({ kind: "unreadable" })).toBe(false);
  });
});

describe("what a read is worth announcing", () => {
  it("announces `on` verbatim; an unreadable mirror as the REFUSAL it produces", () => {
    // Maintenance reports an unreadable mirror as `on` because that is what
    // it refuses with; here the refusal is spelled `on: false`. Either way
    // the plane hears the answer the machine is actually acting on, and a row
    // that disagrees earns the push that rewrites the broken file.
    expect(reportableSshEnabled({ kind: "on", changedAt: STAMP })).toEqual({ on: true, changedAt: STAMP });
    expect(reportableSshEnabled({ kind: "unreadable", changedAt: STAMP })).toEqual({ on: false, changedAt: STAMP });
  });

  it("sends nothing for absent, and nothing an unstamped unreadable", () => {
    expect(reportableSshEnabled({ kind: "absent" })).toBeUndefined();
    expect(reportableSshEnabled({ kind: "unreadable" })).toBeUndefined();
  });
});

describe("set_ssh_enabled (the plane's half)", () => {
  it("persists the plane's exact bytes and memoizes them — no echo, no re-stamp", async () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    const cmd = { type: "set_ssh_enabled", on: true, changedAt: STAMP } satisfies NodeCommandBody;
    expect(await dispatchCommand(ctx, cmd)).toEqual({ ok: true });
    expect(readSshEnabled(dataDir)).toEqual({ kind: "on", changedAt: STAMP });
    expect(ctx.lastReportedSshEnabled).toEqual({ on: true, changedAt: STAMP });
    expect(events).toEqual([]); // the command answers with a result; it announces nothing
  });

  it("an off flip also lands verbatim, and the machine says nothing about it", async () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    await dispatchCommand(ctx, { type: "set_ssh_enabled", on: false, changedAt: "2026-10-07T13:00:00.000Z" });
    maybeReportSshEnabled(ctx);
    expect(events).toEqual([]);
  });
});

describe("the heartbeat belt", () => {
  it("reports a mirror that moved outside the plane's own push, once", () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeSshEnabled(dataDir, { on: true, changedAt: STAMP }); // as a plane push would, memo unmoved

    maybeReportSshEnabled(ctx);
    maybeReportSshEnabled(ctx);

    expect(events).toEqual([{ type: "ssh_enabled", on: true, changedAt: STAMP }]);
    expect(ctx.lastReportedSshEnabled).toEqual({ on: true, changedAt: STAMP });
  });

  it("announces an unreadable mirror once, as the refusal, and repairs nothing itself", () => {
    // The repair is the plane's push (its row wins); a node overwriting the
    // corrupt file would destroy the bytes an operator may want to look at,
    // and inventing an `off` here would mask the disagreement the report
    // exists to raise.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    writeFileSync(sshEnabledPath(dataDir), "{not json");
    const stamp = mtimeOf(dataDir);
    const ctx = makeCtx(dataDir, events);
    const cap = captureLogs();
    try {
      maybeReportSshEnabled(ctx);
      maybeReportSshEnabled(ctx);
    } finally {
      cap.restore();
    }
    expect(events).toEqual([{ type: "ssh_enabled", on: false, changedAt: stamp }]);
    expect(readSshEnabled(dataDir).kind).toBe("unreadable");
  });

  it("a mirror deleted under a live connection is NOT restored — the plane is the only writer", () => {
    // Maintenance re-writes a vanished mirror from its memo because a CLI at
    // the keyboard can delete it legitimately. There is no such writer here:
    // hand-deleting this file is not an interface, and the next `ready` makes
    // the plane push the row value back.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeSshEnabled(dataDir, { on: true, changedAt: STAMP });
    seedSshEnabledMemo(ctx);
    unlinkSync(sshEnabledPath(dataDir));

    maybeReportSshEnabled(ctx);

    expect(events).toEqual([]);
    expect(readSshEnabled(dataDir)).toEqual({ kind: "absent" });
  });

  it("seed returns the value ready carries and silences the first heartbeat for it", () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeSshEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(seedSshEnabledMemo(ctx)).toEqual({ on: true, changedAt: STAMP });
    maybeReportSshEnabled(ctx);
    expect(events).toEqual([]);
    expect(seedSshEnabledMemo(makeCtx(freshDataDir()))).toBeUndefined();
  });
});

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
import { maybeReportPreviewEnabled, seedPreviewEnabledMemo } from "../commands/report.js";
import type { NodeConfig } from "../config.js";
import {
  getPreviewEnabled,
  previewEnabledPath,
  readPreviewEnabled,
  reportablePreviewEnabled,
  setPreviewEnabled,
} from "../preview/flags.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The preview mirror (pane-preview spec Task 3): the SSH capability mirror's
 * twin in mechanics and in default. Persistence and the file-mode doctrine
 * clone `ssh-enabled.ts` exactly (0600, temp+rename, its own file beside it);
 * so does the FAIL-CLOSED read with the allowing default inverted the same way
 * because the plane is the only writer, and "never told" is not "allowed" for a gate
 * that stands over watching panes.
 *
 * The wiring half goes through `dispatchCommand`, so the frame parser and the
 * switch are exercised too (the `commands-ssh-relay.test.ts` posture).
 */

const STAMP = "2026-10-21T10:00:00.000Z";
const made: string[] = [];

function freshDataDir(): string {
  // realpath'd like the commands harnesses: macOS hides /private behind the
  // temp dir, and an assertion about the file path should test the path the
  // daemon itself would write.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subshell-preview-on-")));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The mirror's own mtime, as the unreadable branch stamps it. */
function mtimeOf(dataDir: string): string {
  return statSync(previewEnabledPath(dataDir)).mtime.toISOString();
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
  it("an empty dir reads `absent`: nothing has said yes, so preview is refused", () => {
    expect(readPreviewEnabled(freshDataDir())).toEqual({ kind: "absent" });
  });

  it("round-trips the exact stamp it was given", () => {
    const dataDir = freshDataDir();
    expect(setPreviewEnabled(dataDir, { on: true, changedAt: STAMP })).toEqual({ on: true, changedAt: STAMP });
    expect(readPreviewEnabled(dataDir)).toEqual({ kind: "on", changedAt: STAMP });
  });

  it("stores the whole wire verbatim: `ready.previewEnabled` is buildable from what was written", () => {
    const dataDir = freshDataDir();
    setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(JSON.parse(readFileSync(previewEnabledPath(dataDir), "utf8"))).toEqual({ on: true, changedAt: STAMP });
  });

  it("stores `on: false` as a value too, but the mirror's ANSWER for it is refusal", () => {
    // The plane stamps the file when it turns preview off, and the bytes stay
    // on disk; what the reader answers is the gate's answer, and an off file
    // and no file give the same one. The plane's own row is the record, and
    // it agrees.
    const dataDir = freshDataDir();
    const state = { on: false, changedAt: "2026-10-21T11:00:00.000Z" };
    setPreviewEnabled(dataDir, state);
    expect(JSON.parse(readFileSync(previewEnabledPath(dataDir), "utf8"))).toEqual(state);
    expect(readPreviewEnabled(dataDir)).toEqual({ kind: "absent" });
  });

  it("writes the file 0600, and creates a missing data dir rather than throwing", () => {
    const dataDir = freshDataDir();
    setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(statSync(previewEnabledPath(dataDir)).mode & 0o777).toBe(0o600);
    const nested = join(freshDataDir(), "nested", "data");
    setPreviewEnabled(nested, { on: true, changedAt: STAMP });
    expect(exists(previewEnabledPath(nested))).toBe(true);
  });

  it("leaves no temp file behind, and the file it leaves is whole", () => {
    // Atomic because a half-written file parses as corrupt, and corrupt means
    // REFUSED here, and a torn write would cut preview for the duration.
    const dataDir = freshDataDir();
    setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
    setPreviewEnabled(dataDir, { on: false, changedAt: "2026-10-21T12:00:00.000Z" });
    expect(readdirSync(dataDir)).toEqual(["preview-enabled.json"]);
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
    writeFileSync(previewEnabledPath(dataDir), "{not json");
    const cap = captureLogs();
    try {
      expect(readPreviewEnabled(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("preview"))).toHaveLength(1);
  });

  it("answers `unreadable` for a well-formed file missing a field, and for a non-boolean on", () => {
    // Same classification the SSH mirror gives garbage, and the same reason:
    // both halves or nothing. A content fixture rather than chmod-000: an
    // EACCES read fails into the same branch, so the spellings of "cannot
    // read" must not answer differently.
    const dataDir = freshDataDir();
    writeFileSync(previewEnabledPath(dataDir), JSON.stringify({ on: true }));
    const cap = captureLogs();
    try {
      expect(readPreviewEnabled(dataDir)).toEqual({ kind: "unreadable", changedAt: mtimeOf(dataDir) });
      writeFileSync(previewEnabledPath(dataDir), JSON.stringify({ on: "yes", changedAt: STAMP }));
      expect(readPreviewEnabled(dataDir).kind).toBe("unreadable");
    } finally {
      cap.restore();
    }
  });
});

describe("the gate read", () => {
  it("allows ONLY a parsed on:true mirror; absent, unreadable, and malformed all read as OFF", () => {
    // The whole point of the flag: a node that cannot read its own setting
    // refuses. The SSH twin's classifier pins absent and unreadable; the
    // malformed-shape case joins here as the third because the gate reads a
    // FILE through `getPreviewEnabled`, and a file whose bytes are not a
    // state must answer the same refusal as a missing one.
    const allowed = freshDataDir();
    setPreviewEnabled(allowed, { on: true, changedAt: STAMP });
    expect(getPreviewEnabled(allowed)?.on).toBe(true);

    expect(getPreviewEnabled(freshDataDir())?.on ?? false).toBe(false); // absent

    const corrupt = freshDataDir();
    writeFileSync(previewEnabledPath(corrupt), "{not json");
    expect(getPreviewEnabled(corrupt)?.on ?? false).toBe(false); // unreadable

    const malformed = freshDataDir();
    writeFileSync(previewEnabledPath(malformed), JSON.stringify({ on: true })); // no stamp - not a state
    const cap = captureLogs();
    try {
      expect(getPreviewEnabled(malformed)?.on ?? false).toBe(false); // malformed shape
    } finally {
      cap.restore();
    }
  });
});

describe("what a read is worth announcing", () => {
  it("announces `on` verbatim; an unreadable mirror as the REFUSAL it produces", () => {
    // The machine owes the plane the answer it is actually acting on, and a
    // row that disagrees earns the push that rewrites the broken file.
    expect(reportablePreviewEnabled({ kind: "on", changedAt: STAMP })).toEqual({ on: true, changedAt: STAMP });
    expect(reportablePreviewEnabled({ kind: "unreadable", changedAt: STAMP })).toEqual({
      on: false,
      changedAt: STAMP,
    });
  });

  it("sends nothing for absent, and nothing an unstamped unreadable", () => {
    expect(reportablePreviewEnabled({ kind: "absent" })).toBeUndefined();
    expect(reportablePreviewEnabled({ kind: "unreadable" })).toBeUndefined();
  });
});

describe("set_preview_enabled (the plane's half)", () => {
  it("persists the plane's exact bytes and memoizes them, with no echo and no re-stamp", async () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    const cmd = { type: "set_preview_enabled", on: true, changedAt: STAMP } satisfies NodeCommandBody;
    expect(await dispatchCommand(ctx, cmd)).toEqual({ ok: true });
    expect(readPreviewEnabled(dataDir)).toEqual({ kind: "on", changedAt: STAMP });
    expect(ctx.lastReportedPreviewEnabled).toEqual({ on: true, changedAt: STAMP });
    expect(events).toEqual([]); // the command answers with a result; it announces nothing
  });

  it("an off flip also lands verbatim, and the machine says nothing about it", async () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    await dispatchCommand(ctx, { type: "set_preview_enabled", on: false, changedAt: "2026-10-21T13:00:00.000Z" });
    maybeReportPreviewEnabled(ctx);
    expect(events).toEqual([]);
  });
});

describe("the heartbeat belt", () => {
  it("reports a mirror that moved outside the plane's own push, once", () => {
    // The external-edit case the task exists to cover: the file is rewritten
    // by hand between commands, and the belt re-reads and re-reports it.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    setPreviewEnabled(dataDir, { on: true, changedAt: STAMP }); // as a plane push would, memo unmoved

    maybeReportPreviewEnabled(ctx);
    maybeReportPreviewEnabled(ctx);

    expect(events).toEqual([{ type: "preview_enabled", on: true, changedAt: STAMP }]);
    expect(ctx.lastReportedPreviewEnabled).toEqual({ on: true, changedAt: STAMP });
  });

  it("announces an unreadable mirror once, as the refusal, and repairs nothing itself", () => {
    // The repair is the plane's push (its row wins); a node overwriting the
    // corrupt file would destroy the bytes an operator may want to look at,
    // and inventing an `off` here would mask the disagreement the report
    // exists to raise.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    writeFileSync(previewEnabledPath(dataDir), "{not json");
    const stamp = mtimeOf(dataDir);
    const ctx = makeCtx(dataDir, events);
    const cap = captureLogs();
    try {
      maybeReportPreviewEnabled(ctx);
      maybeReportPreviewEnabled(ctx);
    } finally {
      cap.restore();
    }
    expect(events).toEqual([{ type: "preview_enabled", on: false, changedAt: stamp }]);
    expect(readPreviewEnabled(dataDir).kind).toBe("unreadable");
  });

  it("a mirror deleted under a live connection is NOT restored: the plane is the only writer", () => {
    // Maintenance re-writes a vanished mirror from its memo because a CLI at
    // the keyboard can delete it legitimately. There is no such writer here:
    // hand-deleting this file is not an interface, and the next `ready` makes
    // the plane push the row value back.
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
    seedPreviewEnabledMemo(ctx);
    unlinkSync(previewEnabledPath(dataDir));

    maybeReportPreviewEnabled(ctx);

    expect(events).toEqual([]);
    expect(readPreviewEnabled(dataDir)).toEqual({ kind: "absent" });
  });

  it("seed returns the value ready carries and silences the first heartbeat for it", () => {
    const dataDir = freshDataDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
    expect(seedPreviewEnabledMemo(ctx)).toEqual({ on: true, changedAt: STAMP });
    maybeReportPreviewEnabled(ctx);
    expect(events).toEqual([]);
    expect(seedPreviewEnabledMemo(makeCtx(freshDataDir()))).toBeUndefined();
  });
});

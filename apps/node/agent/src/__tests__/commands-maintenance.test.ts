import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_BINARY_PLACEHOLDER,
  NODE_RESULT_MAINTENANCE,
  type NodeCommandBody,
  type NodeEvent,
} from "@internal/subshell-protocol";
import { writeAllowedDirs } from "../allowed-dirs.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { maybeReportMaintenance, runExitWatchTick, seedMaintenanceMemo, startExitWatcher } from "../commands/report.js";
import type { AgentConfig } from "../config.js";
import { maintenancePath, readMaintenance, writeMaintenance } from "../maintenance.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The maintenance WIRING on the node (spec 2026-09-14 §4.2–§4.4): the launch
 * gate, the `set_maintenance` handler, and the reporting order that makes a
 * machine-side flip legible to the plane as maintenance rather than as a pile
 * of crashes.
 *
 * `maintenance.test.ts` covers the primitive. Everything here goes through
 * `dispatchCommand`, so the frame parser and the switch are exercised too — a
 * command that parses but is never routed would pass an executor-level test.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const STAMP = "2026-09-14T10:00:00.000Z";

const made: string[] = [];

function freshDir(): string {
  // realpath'd: on macOS the temp dir is behind /private and the allowlist
  // check resolves symlinks — a raw path would test the wrong thing.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmd-maint-")));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What the watcher tick needs scripted; everything else throws (see below). */
interface Spec {
  listSubshellsChecked?: (socket: string) => { ok: true; names: string[] } | { ok: false; detail: string };
  paneExitCode?: (socket: string, id: string) => number | null;
}

/**
 * A context whose tmux THROWS on anything unstubbed: reaching tmux at all in a
 * refusal case means the refusal did not happen, and the failure should say so
 * rather than pass quietly.
 */
function makeCtx(dataDir: string, events: NodeEvent[] = [], spec: Spec = {}): CommandContext {
  const config: AgentConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const tmux = new Proxy(spec as Record<string, unknown>, {
    get: (target, prop) =>
      target[prop as string] ??
      (() => {
        throw new Error(`tmux must not be reached; called ${String(prop)}`);
      }),
  });
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

function launchCmd(cwd: string): Extract<NodeCommandBody, { type: "launch" }> {
  return {
    type: "launch",
    subshellId: S1,
    socket: "subshell-maint-test",
    cwd,
    harnessId: "claude-code",
    preset: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
    subshellEnv: {},
    subshellName: "s1",
    argv: [HARNESS_BINARY_PLACEHOLDER],
    resolve: { binaryName: "claude" },
  };
}

describe("set_maintenance", () => {
  it("persists the plane's exact bytes — it never re-stamps what it relays", async () => {
    const dataDir = freshDir();
    const ctx = makeCtx(dataDir);
    expect(await dispatchCommand(ctx, { type: "set_maintenance", on: true, changedAt: STAMP })).toEqual({ ok: true });
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: true, changedAt: STAMP } });
  });

  it("memoizes what it wrote, so the next tick does not echo the plane's own write back", async () => {
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    await dispatchCommand(ctx, { type: "set_maintenance", on: true, changedAt: STAMP });
    expect(ctx.lastReportedMaintenance).toEqual({ on: true, changedAt: STAMP });
    expect(events).toEqual([]); // the command answers with a result; it announces nothing
  });

  it("kills nothing — the plane already terminated the rows it knew about", async () => {
    // The throwing tmux proxy IS the assertion: any pane operation here would
    // be a second, unbookkept teardown of work the plane retired properly.
    const dataDir = freshDir();
    await dispatchCommand(makeCtx(dataDir), { type: "set_maintenance", on: false, changedAt: STAMP });
    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: false, changedAt: STAMP } });
  });
});

describe("the launch gate", () => {
  it("refuses with the BARE constant, before tmux is touched, and reports the stamp once", async () => {
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeMaintenance(dataDir, { on: true, changedAt: STAMP });

    const res = await dispatchCommand(ctx, launchCmd(dataDir));

    // Equality, not a match: the plane compares `detail` to the constant.
    expect(res).toEqual({ ok: false, error: NODE_RESULT_MAINTENANCE });
    expect(events).toEqual([{ type: "maintenance", on: true, changedAt: STAMP }]);
  });

  it("refuses an UNREADABLE mirror and REPORTS it — otherwise the refusal never converges", async () => {
    // RE-BASED (finding 3): this used to assert silence. A node that refuses
    // every launch while telling the plane nothing is a permanent
    // disagreement — the plane shows it launchable, every create 409s, and
    // nothing on either side repairs the file. The stamp is the file's own
    // mtime, which is the only timestamp here that was not invented.
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    writeFileSync(maintenancePath(dataDir), "{not json");

    const res = await dispatchCommand(makeCtx(dataDir, events), launchCmd(dataDir));

    expect(res).toEqual({ ok: false, error: NODE_RESULT_MAINTENANCE });
    expect(events).toEqual([
      { type: "maintenance", on: true, changedAt: statSync(maintenancePath(dataDir)).mtime.toISOString() },
    ]);
  });

  it("lets a launch through when the mirror says off, and announces nothing", async () => {
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    writeMaintenance(dataDir, { on: false, changedAt: STAMP });
    // The allowlist is what refuses here — which is the proof that the
    // maintenance gate passed the launch on to the check behind it.
    writeAllowedDirs(dataDir, [join(dataDir, "work")]);

    const res = await dispatchCommand(makeCtx(dataDir, events), launchCmd(freshDir()));

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("allowed directories");
    expect(events).toEqual([]);
  });

  it("is unaffected with no mirror at all — the backwards-compatible default", async () => {
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    writeAllowedDirs(dataDir, [join(dataDir, "work")]);

    const res = await dispatchCommand(makeCtx(dataDir, events), launchCmd(freshDir()));

    expect(res.ok === false && res.error).toContain("allowed directories");
    expect(events).toEqual([]);
  });
});

describe("reporting order", () => {
  it("emits the flip BEFORE the deaths it caused, in one tick", async () => {
    // The plane serialises frames per socket, so this ordering is what makes
    // a CLI-origin stop read as maintenance rather than as N crashes it
    // should auto-restart. Index comparison, not set membership: the whole
    // property is which frame lands first.
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events, {
      listSubshellsChecked: () => ({ ok: true, names: [] }), // authoritative: the pane is gone
      paneExitCode: () => 0,
    });
    startExitWatcher(ctx, S1, "sock-a", 10_000); // long interval: this test ticks by hand
    writeMaintenance(dataDir, { on: true, changedAt: STAMP });

    await runExitWatchTick(ctx);

    const types = events.map((e) => e.type);
    expect(types.indexOf("maintenance")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("maintenance")).toBeLessThan(types.indexOf("exit"));
    expect(ctx.lastReportedMaintenance).toEqual({ on: true, changedAt: STAMP });
  });

  it("reports one flip once, however many deaths follow it", async () => {
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events, {
      listSubshellsChecked: () => ({ ok: true, names: [] }),
      paneExitCode: () => 0,
    });
    const S2 = "22222222-2222-4222-8222-222222222222";
    startExitWatcher(ctx, S1, "sock-a", 10_000);
    startExitWatcher(ctx, S2, "sock-a", 10_000);
    writeMaintenance(dataDir, { on: true, changedAt: STAMP });

    await runExitWatchTick(ctx);

    expect(events.filter((e) => e.type === "maintenance")).toHaveLength(1);
    expect(events.filter((e) => e.type === "exit")).toHaveLength(2);
  });

  it("stays silent when the mirror has not moved since the last report", async () => {
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events, {
      listSubshellsChecked: () => ({ ok: true, names: [] }),
      paneExitCode: () => 0,
    });
    writeMaintenance(dataDir, { on: true, changedAt: STAMP });
    ctx.lastReportedMaintenance = { on: true, changedAt: STAMP }; // as `ready` would have seeded it
    startExitWatcher(ctx, S1, "sock-a", 10_000);

    await runExitWatchTick(ctx);

    expect(events.map((e) => e.type)).toEqual(["exit"]);
  });
});

describe("an unreadable mirror on the reporting path", () => {
  it("is announced once, and a second tick over the unchanged file says nothing", async () => {
    // The memo is what makes the mtime stamp usable at all: a heartbeat runs
    // every 15 s forever, and a broken file nobody is touching must cost one
    // frame, not one per tick.
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeFileSync(maintenancePath(dataDir), "{not json");
    const stamp = statSync(maintenancePath(dataDir)).mtime.toISOString();

    maybeReportMaintenance(ctx);
    maybeReportMaintenance(ctx);

    expect(events).toEqual([{ type: "maintenance", on: true, changedAt: stamp }]);
    expect(ctx.lastReportedMaintenance).toEqual({ on: true, changedAt: stamp });
  });

  it("is left ON DISK untouched — the bytes are evidence an operator may want", async () => {
    // Unlike the absent case below, a corrupt file is never overwritten from
    // the memo: the repair is the plane's push (or `subshell maintenance
    // off`), and destroying the only copy of what went wrong buys nothing.
    const dataDir = freshDir();
    const ctx = makeCtx(dataDir);
    writeFileSync(maintenancePath(dataDir), "{not json");
    maybeReportMaintenance(ctx);
    expect(readMaintenance(dataDir).kind).toBe("unreadable");
  });
});

describe("a mirror deleted under a live connection", () => {
  it("is restored from the memo — the last value both sides agreed on", async () => {
    // Without this the divergence lasts the whole connection: the plane holds
    // `on` (which it was told), the machine reads "absent ⇒ off", and nothing
    // reports the difference because an absent file has no stamp to send.
    // The memo is not an invention — it IS what this connection told the
    // plane. Hand-deleting the file is not an interface; `subshell
    // maintenance off` is.
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);
    writeMaintenance(dataDir, { on: true, changedAt: STAMP });
    maybeReportMaintenance(ctx);
    expect(events).toHaveLength(1);

    unlinkSync(maintenancePath(dataDir));
    maybeReportMaintenance(ctx);

    expect(readMaintenance(dataDir)).toEqual({ kind: "state", state: { on: true, changedAt: STAMP } });
    expect(events).toHaveLength(1); // the restore re-states nothing: the plane already holds it
  });

  it("is left alone when this connection has reported nothing", async () => {
    // A node that never had a file is the backwards-compatible default, and
    // writing one from an empty memo would invent a flag out of nowhere.
    const dataDir = freshDir();
    const events: NodeEvent[] = [];
    const ctx = makeCtx(dataDir, events);

    maybeReportMaintenance(ctx);

    expect(readMaintenance(dataDir)).toEqual({ kind: "absent" });
    expect(events).toEqual([]);
  });
});

describe("a restore that cannot be written", () => {
  /** A data dir that can never be created: a regular FILE sits where its parent must go. */
  function unwritableDataDir(): string {
    const base = freshDir();
    writeFileSync(join(base, "in-the-way"), "");
    return join(base, "in-the-way", "data");
  }

  it("keeps retrying but says so ONCE per connection", () => {
    // A line per tick is four a minute against a 200 KB cap — the agent's log
    // is replaced roughly six times a day, and on a machine that cannot write
    // its own mirror that is exactly the log an operator needs intact.
    const ctx = makeCtx(unwritableDataDir());
    ctx.lastReportedMaintenance = { on: true, changedAt: STAMP };
    const cap = captureLogs();
    try {
      maybeReportMaintenance(ctx);
      maybeReportMaintenance(ctx);
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("could not restore"))).toHaveLength(1);
  });

  it("says it again on the next connection — still broken an hour later is worth one line per socket", () => {
    const ctx = makeCtx(unwritableDataDir());
    const cap = captureLogs();
    try {
      ctx.lastReportedMaintenance = { on: true, changedAt: STAMP };
      maybeReportMaintenance(ctx);
      seedMaintenanceMemo(ctx); // what a reconnect does: re-seed the memo and its companion flag
      ctx.lastReportedMaintenance = { on: true, changedAt: STAMP };
      maybeReportMaintenance(ctx);
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("could not restore"))).toHaveLength(2);
  });

  it("re-seeding clears the flag even when the mirror reads fine", () => {
    // The flag is seeded WITH the memo, in one function, because a reconnect
    // that reset one and not the other silences the next connection's only
    // warning about a machine that cannot write this file.
    const ctx = makeCtx(freshDir());
    ctx.mirrorRestoreLogged = true;
    seedMaintenanceMemo(ctx);
    expect(ctx.mirrorRestoreLogged).toBe(false);
    expect(ctx.lastReportedMaintenance).toBeUndefined();
  });
});

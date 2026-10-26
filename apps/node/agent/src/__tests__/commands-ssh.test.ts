import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSocketPath } from "@internal/pane-runtime";
import { type JsonValue, NODE_RESULT_MAINTENANCE, type NodeCommandBody } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { writeMaintenance } from "../maintenance.js";
import { writeSshEnabled } from "../ssh-enabled.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The two SSH read arms of the launcher tier (spec 2026-10-07 §4.3/§7), driven
 * through `dispatchCommand` exactly as the daemon drives them (posture copied
 * from commands-maintenance.test.ts: real temp dirs, the local mirror written
 * with its own writer, every refusal asserted by `ok:false` + exact message).
 *
 * What THIS file owns that nothing else does:
 * - the GATE ordering: a machine whose local mirror is not ON answers
 *   `ssh disabled on this node` BEFORE any binary lookup or spawn. The proof
 *   is a working recording shim that never runs (its log file is never even
 *   created) and a broken ladder whose message never surfaces.
 * - discovery's names-only answer from a fixture HOME, through the frozen
 *   wire validator on the way out.
 * - routing: a well-formed `ssh_resolve_config` reaches the HANDLER (it
 *   answers with the handler's own failure class, not dispatch's
 *   `unsupported`). Malformed aliases die at the frame parser before this
 *   point — the tier-1 parser tests own that refusal.
 *
 * The real `ssh -G` behavior against a fixture config is the tier-1 resolver
 * suite's; the composed launch path is the e2e's. Do not re-test either here.
 */

const STAMP = "2026-10-07T10:00:00.000Z";
const GATE_REFUSAL = "ssh disabled on this node";

let base: string;
let savedSshPath: string | undefined;
let savedHome: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-ssh-")));
  savedSshPath = process.env.SUBSHELL_SSH_PATH;
  savedHome = process.env.HOME;
});

afterAll(() => {
  if (savedSshPath === undefined) delete process.env.SUBSHELL_SSH_PATH;
  else process.env.SUBSHELL_SSH_PATH = savedSshPath;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(base, { recursive: true, force: true });
});

/** Recording shim (mirrors the runtime test helper's shape, baked constants). */
function writeShim(dir: string, opts: { dashG?: string } = {}): { bin: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "shim.log");
  const lines = ["#!/bin/sh", `LOG='${log}'`, `printf 'ARGS:%s\\n' "$*" >> "$LOG"`];
  if (opts.dashG !== undefined) {
    lines.push(`for a in "$@"; do if [ "$a" = "-G" ]; then cat <<'GEOF'`);
    lines.push(opts.dashG);
    lines.push("GEOF\nexit 0\nfi; done");
  }
  lines.push("exit 0");
  const bin = join(dir, "ssh");
  writeFileSync(bin, `${lines.join("\n")}\n`, { mode: 0o755 });
  return { bin, log };
}

/** A context whose only meaningful fact is the data dir its gate mirror lives in. */
function makeCtx(dataDir: string): CommandContext {
  return { config: { dataDir } } as unknown as CommandContext;
}

/** Fresh data dir; `on: true` writes the mirror through its real writer. */
function dataDir(tag: string, gate: "absent" | "on" | "unreadable"): string {
  const dir = join(base, tag, "data");
  mkdirSync(dir, { recursive: true });
  if (gate === "on") writeSshEnabled(dir, { on: true, changedAt: STAMP });
  if (gate === "unreadable") writeFileSync(join(dir, "ssh-enabled.json"), "not json at all");
  return dir;
}

/** A fixture HOME whose account config names two hosts. */
function homeWithConfig(tag: string): string {
  const home = join(base, `${tag}-home`);
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), "Host beta\n  User x\nHost alpha\n  HostName a.example\n");
  return home;
}

describe("ssh gate: discovery and resolve refuse before anything runs", () => {
  it("an absent mirror refuses BOTH arms by the exact name, whatever the ladder says", async () => {
    const shim = writeShim(join(base, "shim-gate"), {
      dashG: "host resolved.example\nhostname resolved.example\nuser deploy\nport 22\n",
    });
    process.env.SUBSHELL_SSH_PATH = shim.bin;
    const dir = dataDir("gate-absent", "absent");

    const discovery = await dispatchCommand(makeCtx(dir), { type: "ssh_discover_aliases" } satisfies NodeCommandBody);
    expect(discovery).toEqual({ ok: false, error: GATE_REFUSAL });

    const resolve = await dispatchCommand(makeCtx(dir), {
      type: "ssh_resolve_config",
      alias: "app02",
    } satisfies NodeCommandBody);
    expect(resolve).toEqual({ ok: false, error: GATE_REFUSAL });
    // The gate check PRECEDES the ladder and the spawn: a perfectly good shim
    // was never executed, and an answer computed after lookup would have said
    // something else entirely.
    expect(existsSync(shim.log)).toBe(false);
  });

  it("a broken ladder does not speak first: gate-off answers with the gate's own words", async () => {
    process.env.SUBSHELL_SSH_PATH = "/nonexistent/ssh-binary";
    const res = await dispatchCommand(makeCtx(dataDir("gate-vs-ladder", "absent")), {
      type: "ssh_resolve_config",
      alias: "app02",
    } satisfies NodeCommandBody);
    expect(res).toEqual({ ok: false, error: GATE_REFUSAL });
  });

  it("an unreadable mirror fails CLOSED (refuses) with the same words", async () => {
    const logs = captureLogs();
    try {
      const res = await dispatchCommand(makeCtx(dataDir("gate-unreadable", "unreadable")), {
        type: "ssh_discover_aliases",
      } satisfies NodeCommandBody);
      expect(res).toEqual({ ok: false, error: GATE_REFUSAL });
      // The same classifier gates the resolve arm; pin the pairing, not just one side.
      const res2 = await dispatchCommand(makeCtx(dataDir("gate-unreadable", "unreadable")), {
        type: "ssh_resolve_config",
        alias: "app02",
      } satisfies NodeCommandBody);
      expect(res2).toEqual({ ok: false, error: GATE_REFUSAL });
      expect(logs.lines.join("\n")).toContain("SSH-DISABLED");
      expect(logs.lines.join("\n")).toContain("unreadable");
    } finally {
      logs.restore();
    }
  });
});

describe("ssh_discover_aliases / ssh_resolve_config arms (gate ON)", () => {
  it("discovery answers the sorted NAMES through the validator from the account config", async () => {
    const dir = dataDir("disc", "on");
    process.env.HOME = homeWithConfig("disc");
    const res = await dispatchCommand(makeCtx(dir), { type: "ssh_discover_aliases" } satisfies NodeCommandBody);
    expect(res.ok).toBe(true);
    const data = (res as { data?: JsonValue }).data as {
      aliases: string[];
      includeCycle: boolean;
      truncated: boolean;
    };
    expect(data.aliases).toEqual(["alpha", "beta"]);
    expect(data.includeCycle).toBe(false);
    expect(data.truncated).toBe(false);
  });

  it("a well-formed resolve command REACHES the handler: its own failure class answers, not dispatch's `unsupported`", async () => {
    // Gate ON + a missing binary: only the handler body can produce the
    // binary-missing class. "unsupported" here would mean the dispatch arm is
    // missing; the gate's words here would mean it ran before the ladder.
    process.env.SUBSHELL_SSH_PATH = "/nonexistent/ssh-binary";
    const res = await dispatchCommand(makeCtx(dataDir("reach", "on")), {
      type: "ssh_resolve_config",
      alias: "app02",
    } satisfies NodeCommandBody);
    expect(res.ok).toBe(false);
    expect(String((res as { error?: string }).error)).toInclude("binary missing");
  });
});

describe("ssh_key_bridge: a closed gate or maintenance destroys live signing, not just new ones", () => {
  const pin = "example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  async function openBridge(dir: string): Promise<{ id: string; socketPath: string }> {
    const id = crypto.randomUUID();
    const res = await dispatchCommand(makeCtx(dir), {
      type: "ssh_key_bridge",
      op: "open",
      id,
      hostPin: pin,
    } satisfies NodeCommandBody);
    expect(res.ok).toBe(true);
    const socketPath = buildAgentSocketPath(dir, id);
    await tick();
    expect(existsSync(socketPath)).toBe(true);
    return { id, socketPath };
  }

  it("switching SSH off mid-signing refuses the next exchange AND tears the live agent socket down", async () => {
    const dir = dataDir("bridge-gate-flip", "on");
    const { id, socketPath } = await openBridge(dir);
    writeSshEnabled(dir, { on: false, changedAt: STAMP });
    const res = await dispatchCommand(makeCtx(dir), {
      type: "ssh_key_bridge",
      op: "exchange",
      id,
    } satisfies NodeCommandBody);
    expect(res).toEqual({ ok: false, error: GATE_REFUSAL });
    await tick();
    // The refusal is destruction, not deferral: nothing is left listening on
    // the path the pane's ssh could still be pointed at.
    expect(existsSync(socketPath)).toBe(false);
    // Cleanup stays allowed through a closed gate.
    const close = await dispatchCommand(makeCtx(dir), {
      type: "ssh_key_bridge",
      op: "close",
      id,
    } satisfies NodeCommandBody);
    expect(close.ok).toBe(true);
  });

  it("maintenance on - and an unreadable maintenance mirror, which reads ON - tear the bridge down too", async () => {
    for (const tag of ["bridge-maintenance-on", "bridge-maintenance-unreadable"]) {
      const dir = dataDir(tag, "on");
      const { id, socketPath } = await openBridge(dir);
      if (tag.endsWith("unreadable")) writeFileSync(join(dir, "maintenance.json"), "not json at all");
      else writeMaintenance(dir, { on: true, changedAt: STAMP });
      const res = await dispatchCommand(makeCtx(dir), {
        type: "ssh_key_bridge",
        op: "exchange",
        id,
      } satisfies NodeCommandBody);
      expect(res).toEqual({ ok: false, error: NODE_RESULT_MAINTENANCE });
      await tick();
      expect(existsSync(socketPath)).toBe(false);
    }
  });
});

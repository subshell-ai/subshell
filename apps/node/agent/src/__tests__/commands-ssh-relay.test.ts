import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NodeCommandBody,
  type RelayFrame,
  SSH_RELAY_MAX_PER_NODE,
  type SshRelayOpenCommand,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { type BRelaySessionArgs, RelaySessions } from "../commands/ssh-relay.js";
import { execSshRelayClose, execSshRelayOpen, type RelayOpenSeams } from "../commands/ssh-relay-exec.js";
import { writeSshEnabled } from "../ssh-enabled.js";

/**
 * The relay executor arms (spec 2026-10-08 §5.1, Task 8 acceptance (a) and
 * the probe-off-pump half of the T7 handoff). Posture copied from
 * commands-ssh.test.ts: real temp dirs, the gate mirror written by its own
 * writer, refusals asserted by `ok:false` + exact message.
 *
 * What THIS file owns that nothing else does:
 * - the dispatch arms exist: `ssh_relay_open` and `ssh_relay_close` answer
 *   from the executor, never the switch's `unsupported`.
 * - the GATE (mirror first) on open; and that CLOSE is not gated - teardown
 *   must land even while a machine is switched off.
 * - acceptance (a) in both role branches: A drives the openARelaySession
 *   seam, B drives openBRelaySession with the COMMAND's paneId (grammar (b)
 *   end to end), B's answer carries the socket path the plane will byte-check.
 * - the T7 obligation: the A branch does not await the numbering probe on
 *   the shared command chain - a stuck agent's openARelaySession must not
 *   serialize anything behind it (the never-resolving seam is the proof),
 *   and its late named refusal lands in the log, never as an uncaught throw.
 * - the ctx.relay plumbing check (a daemon built without it refuses loudly).
 */

const STAMP = "2026-10-08T10:00:00.000Z";
const GATE_REFUSAL = "ssh disabled on this node";
const PANE = "11111111-2222-4333-8444-555555555555";

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-relay-")));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function dataDir(tag: string, gateOn: boolean): string {
  const dir = join(base, tag, "data");
  mkdirSync(dir, { recursive: true });
  if (gateOn) writeSshEnabled(dir, { on: true, changedAt: STAMP });
  return dir;
}

function makeCtx(tag: string, opts: { gateOn?: boolean; nodeId?: string; relay?: boolean } = {}) {
  const data = dataDir(tag, opts.gateOn ?? true);
  const sends: RelayFrame[] = [];
  const relay =
    opts.relay === false
      ? undefined
      : { sessions: new RelaySessions(), sendRelayFrame: (f: RelayFrame) => sends.push(f) };
  const ctx = { config: { dataDir: data, nodeId: opts.nodeId ?? "node-self" }, relay } as unknown as CommandContext;
  return { ctx, sends, relay };
}

function openCmd(over: Partial<SshRelayOpenCommand> = {}): SshRelayOpenCommand {
  return {
    type: "ssh_relay_open",
    relayId: "relay-1",
    ref: "r-1",
    role: "A",
    aNodeId: "node-self",
    bNodeId: "node-peer",
    peerSigningPublicKey: '{"kty":"EC","crv":"P-256","x":"AX","y":"AY"}',
    peerEncryptPublicKey: Buffer.from('{"kty":"EC","crv":"P-256","x":"BX","y":"BY"}', "utf8").toString("base64"),
    fingerprints: ["SHA256:AAAA"],
    lifetimeMs: 30_000,
    paneId: PANE,
    // Task 12: the relay-open's required destination pin; the B branch writes
    // it to the pane's 0600 known_hosts file before binding the socket.
    hostPin: "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000",
    ...over,
  };
}

describe("the dispatch arms exist (acceptance (a))", () => {
  it("ssh_relay_open reaches the executor, not the switch's unsupported", async () => {
    const { ctx } = makeCtx("dispatch");
    // Role B naming a different machine as B: the executor's own first guard
    // answers, which is the proof the arm exists (an unwired switch says
    // `unsupported`, never this sentence).
    const res = await dispatchCommand(ctx, openCmd({ role: "B", aNodeId: "other", bNodeId: "not-me" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("not the connecting side");
  });

  it("ssh_relay_close reaches RelaySessions.close and an unknown ref is an idempotent ok", async () => {
    const { ctx, relay } = makeCtx("dispatch-close");
    const res = await dispatchCommand(ctx, { type: "ssh_relay_close", ref: "r-none", reason: "child-exit" });
    expect(res).toEqual({ ok: true, data: { ref: "r-none", closed: false } });
    const closed: string[] = [];
    relay?.sessions.register("r-live", { onRelayFrame: () => {}, close: (reason) => closed.push(reason) });
    const res2 = await dispatchCommand(ctx, {
      type: "ssh_relay_close",
      ref: "r-live",
      reason: "a-dropped",
    } as NodeCommandBody);
    expect(res2).toEqual({ ok: true, data: { ref: "r-live", closed: true } });
    expect(closed).toEqual(["a-dropped"]); // §5.1: the named reason reaches the endpoint
  });

  it("a daemon context WITHOUT the relay plumbing refuses, loudly", async () => {
    const { ctx } = makeCtx("no-plumbing", { relay: false });
    const res = await dispatchCommand(ctx, openCmd());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("relay plumbing");
  });
});

describe("the gate (mirror first, spec §4.3)", () => {
  it("an off mirror refuses ssh_relay_open before any pairing mechanics", async () => {
    const { ctx } = makeCtx("gate-off", { gateOn: false });
    const res = await execSshRelayOpen(ctx, openCmd({ role: "B" }));
    expect(res).toEqual({ ok: false, error: GATE_REFUSAL });
  });

  it("ssh_relay_close is NOT gated: teardown answers even while the machine is switched off", async () => {
    const { ctx } = makeCtx("gate-off-close", { gateOn: false });
    const res = await execSshRelayClose(ctx, { type: "ssh_relay_close", ref: "r-x", reason: "access-revoked" });
    expect(res).toEqual({ ok: true, data: { ref: "r-x", closed: false } });
  });
});

describe("the A branch: the probe runs OFF the command chain (T7 handoff)", () => {
  it("acks immediately while openARelaySession is still running", async () => {
    const { ctx } = makeCtx("a-slow");
    let started: (() => void) | undefined;
    const never = new Promise<{ relayId: string }>((resolve) => {
      started = () => resolve({ relayId: "relay-1" });
    });
    const seams: RelayOpenSeams = {
      openA: async () => never,
      openB: async () => {
        throw new Error("must not run");
      },
    };
    const exec = execSshRelayOpen(ctx, openCmd({ role: "A" }), seams);
    // The proof is timing: if the executor awaited the probe, this race would
    // resolve with the timeout instead of the ack.
    const winner = await Promise.race([
      exec.then((r) => ({ kind: "ack" as const, r })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 25)),
    ]);
    expect(winner.kind).toBe("ack");
    if (winner.kind === "ack") {
      expect(winner.r).toEqual({ ok: true, data: { role: "A", relayId: "relay-1", pending: true } });
    }
    started?.(); // let the detached promise settle so nothing leaks a rejection
    await never;
  });

  it("a late named refusal from the detached open lands in the log and never throws past the arm", async () => {
    const { ctx } = makeCtx("a-refuse");
    const lines: string[] = [];
    const seams: RelayOpenSeams = {
      openA: async () => {
        throw new Error("machine pin for node-peer has MOVED");
      },
      openB: async () => {
        throw new Error("must not run");
      },
      log: (line) => lines.push(line),
    };
    const res = await execSshRelayOpen(ctx, openCmd({ role: "A" }), seams);
    expect(res.ok).toBe(true); // the ack was already earned; the refusal is a LOG fact (§4.5: re-pair is an operator act at the machine)
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lines.join("\n")).toContain("MOVED");
    expect(lines.join("\n")).toContain("r-1");
  });
});

describe("the B branch: the pane rides the command, the answer carries the socket", () => {
  it("openBRelaySession gets the COMMAND's paneId and its socket path answers back", async () => {
    const { ctx, relay } = makeCtx("b-ok");
    const seenArgs: BRelaySessionArgs[] = [];
    const seams: RelayOpenSeams = {
      openA: async () => {
        throw new Error("must not run");
      },
      openB: async (args) => {
        seenArgs.push(args);
        relay?.sessions.register(args.cmd.ref, { onRelayFrame: () => {}, close: () => {} });
        return { socketPath: `${args.dataDir}/ssh/${args.paneId}/agent.sock` };
      },
    };
    const res = await execSshRelayOpen(ctx, openCmd({ role: "B", aNodeId: "node-peer", bNodeId: "node-self" }), seams);
    expect(seenArgs).toHaveLength(1);
    expect(seenArgs[0]?.paneId).toBe(PANE); // grammar (b): the pane arrives on the WIRE, not a side channel
    expect(seenArgs[0]?.selfNodeId).toBe("node-self");
    expect(seenArgs[0]?.cmd.role).toBe("B");
    expect(res).toEqual({
      ok: true,
      data: { role: "B", relayId: "relay-1", socketPath: `${ctx.config.dataDir}/${"ssh"}/${PANE}/agent.sock` },
    });
  });

  it("a throwing open (moved pin, bad keys, owned ref) answers ok:false with the named refusal", async () => {
    const { ctx } = makeCtx("b-refuse");
    const seams: RelayOpenSeams = {
      openA: async () => {
        throw new Error("must not run");
      },
      openB: async () => {
        throw new Error("relay open refused: machine pin for node-peer has MOVED (re-pair per §4.5)");
      },
    };
    const res = await execSshRelayOpen(ctx, openCmd({ role: "B", aNodeId: "node-peer", bNodeId: "node-self" }), seams);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("MOVED");
  });
});

describe("RelaySessions concurrency bound (acceptance (g), node-side defense)", () => {
  const handler = { onRelayFrame: () => {}, close: () => {} };

  it("rejects a 9th concurrent session with a named refusal and keeps the dup-ref false", () => {
    const relay = new RelaySessions();
    for (let i = 0; i < SSH_RELAY_MAX_PER_NODE; i += 1) expect(relay.register(`r-${i}`, handler)).toBe(true);
    // The existing dup-ref contract is UNCHANGED: false, no throw.
    expect(relay.register("r-0", handler)).toBe(false);
    // A NEW ref over the cap is a loud named refusal (defense-in-depth; the
    // plane's quota is authoritative, this is the machine refusing to hold a
    // 9th proxy anyway).
    expect(() => relay.register(`r-${SSH_RELAY_MAX_PER_NODE}`, handler)).toThrow(/max 8/);
    expect(relay.size).toBe(SSH_RELAY_MAX_PER_NODE);
    // Releasing a ref frees a slot: the next register lands.
    relay.close("r-3", "lifetime-expiry");
    expect(relay.register(`r-${SSH_RELAY_MAX_PER_NODE}`, handler)).toBe(true);
  });

  it("a THROWN cap refusal does not create a session and the refused opener can still release itself", () => {
    // The call-site contract the executors rely on (fix round T8 MAJOR 1):
    // every refusal path of register leaves the registry exactly as it was,
    // so the OPENERS cleanup (its try/catch around register) is the whole
    // release story - the cap throw must not half-own anything.
    const relay = new RelaySessions();
    for (let i = 0; i < SSH_RELAY_MAX_PER_NODE; i += 1) relay.register(`r-${i}`, handler);
    expect(() => relay.register("r-over", handler)).toThrow(/relay registry full/);
    expect(relay.size).toBe(SSH_RELAY_MAX_PER_NODE);
    expect(relay.has("r-over")).toBe(false);
  });
});

describe("RelaySessions close tombstones (fix round T8 MAJOR 2)", () => {
  const handler = { onRelayFrame: () => {}, close: () => {} };

  it("remembers a close of an UNKNOWN ref, refuses a late register, and expires the tombstone", () => {
    // The clock and the TTL are injected: the race window (a detached open
    // worst-case ~20 s deep in its probe) is real time the suite cannot pay.
    let now = 1_000_000;
    const relay = new RelaySessions(undefined, { nowMs: () => now, tombstoneMs: 5_000 });
    // The plane's cut lands BEFORE the open ever registers: nothing is owned,
    // and the answer stays the honest `closed: false` the executor answers.
    expect(relay.close("r-late", "handshake-grace")).toBe(false);
    expect(relay.isTombstoned("r-late")).toBe(true);
    // A late SUCCESS must not own a ref the plane already dropped.
    expect(relay.register("r-late", handler)).toBe(false);
    expect(relay.size).toBe(0);
    // A close of an OWNED ref is NOT tombstoned: it took the normal path.
    expect(relay.register("r-own", handler)).toBe(true);
    expect(relay.close("r-own", "lifetime-expiry")).toBe(true);
    expect(relay.isTombstoned("r-own")).toBe(false);
    // The set is TTL-bounded, not a growing ledger: after the tombstone
    // expires, the ref (or any other) registers normally again.
    now += 5_001;
    expect(relay.isTombstoned("r-late")).toBe(false);
    expect(relay.register("r-late", handler)).toBe(true);
  });

  it("sweeps expired tombstones on every touch so repeated unknown closes stay bounded", () => {
    let now = 0;
    const lines: string[] = [];
    const relay = new RelaySessions((line) => lines.push(line), { nowMs: () => now, tombstoneMs: 100 });
    for (let i = 0; i < 50; i += 1) expect(relay.close(`r-${i}`, "access-revoked")).toBe(false);
    now += 101; // every tombstone is now past its TTL
    expect(relay.register("sweep-probe", handler)).toBe(true); // the sweep ran at register
    for (let i = 0; i < 50; i += 1) expect(relay.isTombstoned(`r-${i}`)).toBe(false);
    // The remembered close is observable in the log (ids and the named
    // reason only - the same refusal vocabulary every relay line keeps).
    expect(lines.some((l) => l.includes("r-0") && l.includes("access-revoked"))).toBe(true);
  });
});

describe("the daemon seam wiring", () => {
  it("the B branch's sendRelayFrame is the ctx pump (deliver-or-throw, forwarded unchanged)", async () => {
    const { ctx, sends } = makeCtx("b-pump");
    const seams: RelayOpenSeams = {
      openA: async () => {
        throw new Error("must not run");
      },
      openB: async (args) => {
        // The proxy hands the pump a frame; whatever it does is the pump's
        // contract - here the ctx recorder proves identity of the seam.
        args.sendRelayFrame({ type: "relay", ref: args.cmd.ref, seq: 0, direction: "B2A", blob: "QUJD" });
        return { socketPath: "/x/agent.sock" };
      },
    };
    await execSshRelayOpen(ctx, openCmd({ role: "B", aNodeId: "node-peer", bNodeId: "node-self" }), seams);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.ref).toBe("r-1");
  });
});

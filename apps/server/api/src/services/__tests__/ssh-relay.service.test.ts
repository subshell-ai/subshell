import { describe, expect, it } from "bun:test";
import { buildAgentSocketPath } from "@internal/pane-runtime";
import type {
  NodeCommandBody,
  RelayFrame,
  SshRelayCloseReason,
  SshRelayOpenCommand,
} from "@internal/subshell-protocol";
import {
  NODE_PROTOCOL_VERSION,
  SSH_RELAY_LIFETIME_MS,
  SSH_RELAY_MAX_PER_NODE,
  SSH_RELAY_TEARDOWN_GRACE_MS,
} from "@internal/subshell-protocol";
import type { NodeSocket } from "@/services/nodes/node-registry.js";
import { attachConnection, getLive, resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import {
  closeRelayForPaneExit,
  createRelayBroker,
  type RelayBroker,
  RelaySendError,
  sendRelayFrameOverNodeSocket,
  setRelayBrokerForTests,
  sshRelayPaneEnv,
  sweepRelayForPane,
} from "@/services/ssh-relay.service.js";

/**
 * The plane relay broker (spec 2026-10-08 §5.1/§5.3/§5.5/§5.6, Task 8). The
 * whole file runs against injected seams: no DB, no socket, no real clock.
 * The acceptance gates get their own named test:
 * (a) both opens are delivered as signed commands with the role branches and
 * the close reaches both sides; (b) paneId carriage + refusal;
 * (c) the per-node send glue throws on a dropped send and a frame routed to
 * a dead peer tears the session down; (d) `ssh_enabled` and `local` refuse
 * before anything is brokered; (e) SSH_AUTH_SOCK leaves ONLY as the scoped
 * one-key pane env, byte-matching the B answer's socket path; (f) every
 * §5.6 cut fires its named reason through injectable timers; (g) the quota
 * is a loud refusal touching nothing; (h) the peer encryption key is carried
 * as base64 of the UTF-8 JSON public JWK, and the plane is BLIND (§5.5):
 * routing is a byte-for-byte copy and no session record ever holds a blob.
 */

const PIN_LINE = `git.example.test ssh-ed25519 ${"A".repeat(51)}`;
const PANE = "11111111-2222-4333-8444-555555555555";
const A_SIGNING = '{"kty":"EC","crv":"P-256","x":"AX","y":"AY","use":"sig"}';
const A_ENCRYPT = '{"kty":"EC","crv":"P-256","x":"EX","y":"EY","use":"enc"}';
const B_SIGNING = '{"kty":"EC","crv":"P-256","x":"BX","y":"BY","use":"sig"}';
const B_ENCRYPT = '{"kty":"EC","crv":"P-256","x":"FX","y":"FY","use":"enc"}';
const FINGERPRINTS = ["SHA256:AAAA", "SHA256:BBBB"];

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const frame = (over: Partial<RelayFrame> = {}): RelayFrame => ({
  type: "relay",
  ref: "r-unknown",
  seq: 0,
  direction: "B2A",
  blob: "QUJDk5+ToQ==", // opaque; the broker must never decode it
  ...over,
});

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  cancelled: boolean;
}

function makeHarness(
  opts: {
    rows?: Record<string, { kind: "agent" | "local"; sshEnabled: number | null } | null>;
    dataDir?: string | null;
    ack?: (nodeId: string, cmd: NodeCommandBody) => unknown | Promise<unknown>;
    authorize?: (userId: string, nodeId: string) => Promise<boolean>;
    relaySend?: (nodeId: string, frame: RelayFrame) => void;
  } = {},
) {
  const clock = { now: 1_730_000_000_000 };
  const timers: FakeTimer[] = [];
  let nextTimer = 1;
  const commands: { nodeId: string; cmd: NodeCommandBody }[] = [];
  const relayFrames: { nodeId: string; frame: RelayFrame }[] = [];
  const audits: {
    action: string;
    actorUserId: string | null;
    targetType: string | null;
    targetId: string | null;
    meta: Record<string, unknown>;
  }[] = [];
  const lines: string[] = [];
  const rows = opts.rows ?? { a: { kind: "agent", sshEnabled: 1 }, b: { kind: "agent", sshEnabled: 1 } };
  const defaultAck = (_nodeId: string, cmd: NodeCommandBody): unknown =>
    cmd.type === "ssh_relay_open" && cmd.role === "B"
      ? { role: "B", relayId: cmd.relayId, socketPath: buildAgentSocketPath(opts.dataDir ?? "/data/b", cmd.paneId) }
      : cmd.type === "ssh_relay_open"
        ? { role: "A", relayId: cmd.relayId }
        : { ok: true };

  const broker: RelayBroker = createRelayBroker({
    authorize: opts.authorize ?? (async () => true),
    async sendCommand(nodeId, cmd) {
      commands.push({ nodeId, cmd });
      return (opts.ack ?? defaultAck)(nodeId, cmd);
    },
    sendRelayFrame(nodeId, f) {
      relayFrames.push({ nodeId, frame: f });
      if (opts.relaySend) return opts.relaySend(nodeId, f);
      throw new RelaySendError(nodeId, "fake pump always drops");
    },
    async nodeRow(nodeId) {
      const r = rows[nodeId];
      return r === undefined ? null : r;
    },
    nodeDataDir: () => (opts.dataDir === undefined ? "/data/b" : opts.dataDir),
    async audit(e) {
      audits.push({ ...e, meta: JSON.parse(e.metadataJson ?? "{}") as Record<string, unknown> });
    },
    nowMs: () => clock.now,
    schedule: (fn, ms) => {
      const t: FakeTimer = { id: nextTimer, at: clock.now + ms, fn, cancelled: false };
      nextTimer += 1;
      timers.push(t);
      return t;
    },
    cancel: (t) => {
      (t as FakeTimer).cancelled = true;
    },
    log: (line) => lines.push(line),
  });

  const fireDue = (): number => {
    let fired = 0;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= clock.now).sort((x, y) => x.at - y.at)[0];
      if (!due) return fired;
      due.cancelled = true;
      due.fn();
      fired += 1;
    }
  };

  return {
    broker,
    commands,
    relayFrames,
    audits,
    lines,
    timers,
    clock,
    advance: async (ms: number) => {
      clock.now += ms;
      // A macrotask turn drains every microtask chain the fake scheduler's
      // callbacks started (allSettleds, awaits in closeRelay).
      await new Promise((r) => setTimeout(r, 0));
      fireDue();
      await new Promise((r) => setTimeout(r, 0));
    },
    open: (over: Partial<Parameters<RelayBroker["openRelay"]>[0]> = {}) =>
      broker.openRelay({
        identityGenerations: {
          a: broker.identityGeneration(over.aNode ?? "a"),
          b: broker.identityGeneration(over.bNode ?? "b"),
        },
        userId: "grant-1",
        fingerprints: FINGERPRINTS,
        paneId: PANE,
        aNode: "a",
        bNode: "b",
        aPeer: { signingPublicKey: A_SIGNING, encryptionPublicJwk: A_ENCRYPT },
        bPeer: { signingPublicKey: B_SIGNING, encryptionPublicJwk: B_ENCRYPT },
        // Task 12: the destination's pin is REQUIRED at the broker; the base
        // carries a well-formed line and one refusal test drops it.
        hostPin: PIN_LINE,
        ...over,
      }),
  };
}

/* ------------------------------------------------------------------ */
/* openRelay: pairing, carriage, gates, quota                          */
/* ------------------------------------------------------------------ */

describe("openRelay (spec §5.1/§5.3, Task 8 (a)(b)(d)(g)(h))", () => {
  it("pairs A and B with an opaque ref and delivers the whole pairing to BOTH sides", async () => {
    const h = makeHarness();
    const r = await h.open();
    // Opaque ids, minted by the plane; the ref is the blind pairing key.
    expect(r.ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.relayId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.ref).not.toBe(r.relayId);
    expect(new Date(r.expiresAt).getTime()).toBe(h.clock.now + SSH_RELAY_LIFETIME_MS);

    const toA = h.commands.find((c) => c.nodeId === "a")?.cmd as SshRelayOpenCommand | undefined;
    const toB = h.commands.find((c) => c.nodeId === "b")?.cmd as SshRelayOpenCommand | undefined;
    expect(toA?.type).toBe("ssh_relay_open");
    expect(toB?.type).toBe("ssh_relay_open");
    // (a) the role branches name each machine what it is; one ref pairs them.
    expect(toA?.role).toBe("A");
    expect(toB?.role).toBe("B");
    expect(toA?.ref).toBe(r.ref);
    expect(toB?.ref).toBe(r.ref);
    expect(toA?.relayId).toBe(r.relayId);
    expect(toA?.aNodeId).toBe("a");
    expect(toA?.bNodeId).toBe("b");
    expect(toA?.lifetimeMs).toBe(SSH_RELAY_LIFETIME_MS);
    // Each side is told the PEER's keys to pin, never its own.
    expect(toA?.peerSigningPublicKey).toBe(B_SIGNING);
    expect(toB?.peerSigningPublicKey).toBe(A_SIGNING);
    // (h) the encryption half is base64 of the UTF-8 JSON public JWK - the
    // exact spelling the node decodes and the pin store holds.
    expect(toA?.peerEncryptPublicKey).toBe(b64(B_ENCRYPT));
    expect(Buffer.from(String(toA?.peerEncryptPublicKey), "base64").toString("utf8")).toBe(B_ENCRYPT);
    expect(toB?.peerEncryptPublicKey).toBe(b64(A_ENCRYPT));
    // (b) the pane rides the command (the B proxy socket is named by it).
    expect(toA?.paneId).toBe(PANE);
    expect(toB?.paneId).toBe(PANE);
    // (a) the grant's selected fingerprints are delivered for A's responder.
    expect(toA?.fingerprints).toEqual(FINGERPRINTS);
    expect(toA).not.toHaveProperty("userId");
    // Task 12 (spec §9): the destination's pinned host-key line rides the
    // signed open to BOTH sides (B writes it beside the socket it binds); the
    // audit still names only ids, never the pin bytes.
    expect(toA?.hostPin).toBe(PIN_LINE);
    expect(toB?.hostPin).toBe(PIN_LINE);
    expect(JSON.stringify(h.audits[0]?.meta ?? {})).not.toContain("ssh-ed25519");
    // The open is audited once, ids only.
    expect(h.audits.map((a) => a.action)).toEqual(["node.ssh_relay.open"]);
    expect(h.audits[0]?.meta).toEqual({
      relayId: r.relayId,
      ref: r.ref,
      userId: "grant-1",
      paneId: PANE,
      aNodeId: "a",
      bNodeId: "b",
      fingerprintCount: FINGERPRINTS.length,
      lifetimeMs: SSH_RELAY_LIFETIME_MS,
    });
    expect(h.audits[0]?.actorUserId).toBeNull();
    // And the plane records both sides as opened once the acks land.
    const info = h.broker.sessionInfo(r.ref);
    expect(info).not.toBeNull();
    expect(info?.aOpened).toBe(true);
    expect(info?.bOpened).toBe(true);
  });

  it("answers the verified B socket path, byte-matching the shared derivation", async () => {
    const h = makeHarness();
    const r = await h.open();
    expect(r.socketPath).toBe(buildAgentSocketPath("/data/b", PANE));
  });

  it("refuses a B answer whose socket path is not THIS pane's derived path (never trusts a machine claim)", async () => {
    const h = makeHarness({
      ack: (_nodeId, cmd) =>
        cmd.type === "ssh_relay_open" && cmd.role === "B"
          ? { role: "B", relayId: cmd.relayId, socketPath: "/attacker/agent.sock" }
          : { role: "A" },
    });
    await expect(h.open()).rejects.toMatchObject({ code: "bad-socket-path" });
    // The session was torn down and BOTH sides were told, under a named cut.
    expect(h.broker.sessionInfo(h.audits[0]?.meta.ref as string)).toBeNull();
    const closes = h.commands.filter((c) => c.cmd.type === "ssh_relay_close");
    expect(closes.map((c) => c.nodeId).sort()).toEqual(["a", "b"]);
    expect(h.audits.map((a) => a.action)).toEqual(["node.ssh_relay.open", "node.ssh_relay.close"]);
  });

  it("refuses a missing or non-string B socket answer the same way", async () => {
    const h = makeHarness({
      ack: (_nodeId, cmd) =>
        cmd.type === "ssh_relay_open" && cmd.role === "B" ? { role: "B", relayId: cmd.relayId } : { role: "A" },
    });
    await expect(h.open()).rejects.toMatchObject({ code: "bad-socket-path" });
  });

  it("refuses a node whose ssh gate is off or has no row - before any command or audit (acceptance (d))", async () => {
    for (const [rows, code] of [
      [{ a: { kind: "agent" as const, sshEnabled: 0 }, b: { kind: "agent" as const, sshEnabled: 1 } }, "node-off"],
      [{ a: null, b: { kind: "agent" as const, sshEnabled: 1 } }, "no-node"],
      [{ a: { kind: "agent" as const, sshEnabled: null }, b: { kind: "agent" as const, sshEnabled: 1 } }, "node-off"],
    ] as const) {
      const h = makeHarness({ rows: rows as never });
      await expect(h.open()).rejects.toMatchObject({ code });
      expect(h.commands).toHaveLength(0);
      expect(h.audits).toHaveLength(0);
      expect(h.broker.activeRelayCount("a")).toBe(0);
    }
  });

  it("refuses the same machine as both A and B, and a paneId outside the path-composition shape (acceptance (b))", async () => {
    const h = makeHarness();
    await expect(h.open({ aNode: "a", bNode: "a" })).rejects.toMatchObject({ code: "same-node" });
    await expect(h.open({ paneId: "../escape" })).rejects.toMatchObject({ code: "bad-pane-id" });
    await expect(h.open({ paneId: "" })).rejects.toMatchObject({ code: "bad-pane-id" });
    await expect(h.open({ paneId: "x".repeat(65) })).rejects.toMatchObject({ code: "bad-pane-id" });
    await expect(h.open({ fingerprints: ["not-a-fingerprint"] })).rejects.toMatchObject({ code: "bad-fingerprints" });
    // Task 12 (spec §9): the pin door at the mint - a session without the
    // destination's pinned line does not exist, so a missing, empty, or
    // multi-line hostPin is refused BEFORE any command leaves the plane.
    await expect(h.open({ hostPin: "" })).rejects.toMatchObject({ code: "bad-host-pin" });
    await expect(h.open({ hostPin: undefined })).rejects.toMatchObject({ code: "bad-host-pin" });
    await expect(h.open({ hostPin: "host ssh-rsa AAA\nsecond ssh-rsa BBB" })).rejects.toMatchObject({
      code: "bad-host-pin",
    });
    expect(h.commands).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("enforces SSH_RELAY_MAX_PER_NODE as a loud refusal that touches nothing (acceptance (g))", async () => {
    const h = makeHarness({
      rows: {
        a: { kind: "agent", sshEnabled: 1 },
        b: { kind: "agent", sshEnabled: 1 },
        "fresh-b": { kind: "agent", sshEnabled: 1 },
      },
    });
    for (let i = 0; i < SSH_RELAY_MAX_PER_NODE; i += 1) {
      await h.open({ paneId: `pane-${i}`, userId: `grant-${i}` });
    }
    expect(h.broker.activeRelayCount("b")).toBe(SSH_RELAY_MAX_PER_NODE);
    const auditsBefore = h.audits.length;
    const commandsBefore = h.commands.length;
    await expect(h.open({ paneId: "pane-over", userId: "grant-over" })).rejects.toMatchObject({
      code: "quota",
      nodeId: "a",
    });
    expect(h.audits).toHaveLength(auditsBefore); // no half-done audit
    expect(h.commands).toHaveLength(commandsBefore); // no half-delivered command
    // The cap counts each of A and B: a node at the cap cannot join even as A.
    await expect(
      h.open({ paneId: "pane-as-a", userId: "grant-as-a", aNode: "b", bNode: "fresh-b" }),
    ).rejects.toMatchObject({ code: "quota", nodeId: "b" });
    // A closed slot frees room (the count is LIVE sessions, not history).
    const first = h.broker.sessionInfo(h.audits[0]?.meta.ref as string);
    expect(first).not.toBeNull();
    await h.broker.closeRelay(first?.ref as string, "lifetime-expiry");
    await expect(h.open({ paneId: "pane-over", userId: "grant-over" })).resolves.toMatchObject({});
  });

  it("arms the lifetime and the grace on the INJECTED timers only (no real 30 s waits)", async () => {
    const h = makeHarness();
    await h.open();
    const armed = h.timers.map((t) => t.at - 1_730_000_000_000).sort((a, b) => a - b);
    expect(armed).toEqual([SSH_RELAY_TEARDOWN_GRACE_MS, SSH_RELAY_LIFETIME_MS]);
  });
});

/* ------------------------------------------------------------------ */
/* routing: blind, by ref, throw-on-drop teardown                      */
/* ------------------------------------------------------------------ */

describe("routeRelayFrame (spec §5.5, Task 8 (c))", () => {
  it("forwards the blob byte-for-byte to the peer and holds nothing itself", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    const f = frame({ ref: r.ref, direction: "B2A", blob: b64(JSON.stringify({ secret: "agent bytes" })) });
    h.broker.routeRelayFrame("b", f);
    expect(h.relayFrames).toHaveLength(1);
    expect(h.relayFrames[0]?.nodeId).toBe("a");
    // The exact same frame, same strings, same objects: an unopened copy.
    expect(h.relayFrames[0]?.frame).toBe(f);
    // The plane read the ref and nothing else: the session record has no
    // blob slot at any point in its life (§5.5), and never gained one.
    const info = h.broker.sessionInfo(r.ref);
    expect(Object.keys(info ?? {}).sort()).toEqual(
      ["aNode", "aOpened", "bNode", "bOpened", "expiresAt", "userId", "paneId", "ref", "relayId", "socketPath"].sort(),
    );
    // ...and the session view never holds the blob, encoded or decoded.
    expect(JSON.stringify(info)).not.toContain(f.blob);
    expect(JSON.stringify(info)).not.toContain("agent bytes");
    // Both directions route; A's reply rides to B untouched.
    h.broker.routeRelayFrame("a", frame({ ref: r.ref, direction: "A2B", seq: 0 }));
    expect(h.relayFrames[1]?.nodeId).toBe("b");
  });

  it("drops a frame for an unbrokered ref and a frame from a node that is not a party", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    h.broker.routeRelayFrame("b", frame({ ref: "r-not-brokered" }));
    h.broker.routeRelayFrame("stranger", frame({ ref: r.ref }));
    expect(h.relayFrames).toHaveLength(0);
    expect(h.broker.sessionInfo(r.ref)).not.toBeNull(); // a drop is not a teardown
  });

  it("a frame routed to a dead A peer throws through the glue and the session is torn down, not left spinning (acceptance (c))", async () => {
    const h = makeHarness(); // the fake pump DROPS (throws) by default
    const r = await h.open();
    h.broker.routeRelayFrame("b", frame({ ref: r.ref }));
    // The teardown it triggers is async (the close sends, then the audit).
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The phantom-hang direction (B's request cannot reach A): the plane cuts
    // now, with the named reason, and both sides are told.
    const closes = h.commands.filter((c) => c.cmd.type === "ssh_relay_close");
    expect(closes).toHaveLength(2);
    expect(closes[0]?.cmd).toEqual({ type: "ssh_relay_close", ref: r.ref, reason: "a-dropped" });
    expect(h.broker.sessionInfo(r.ref)).toBeNull();
    expect(h.audits.map((a) => a.action)).toEqual(["node.ssh_relay.open", "node.ssh_relay.close"]);
    expect(h.audits[1]?.meta.reason).toBe("a-dropped");
  });

  it("an undeliverable reply to a dead B loses the frame but not the session (no b-dropped word exists; the caps own it)", async () => {
    const h = makeHarness();
    const r = await h.open();
    h.broker.routeRelayFrame("a", frame({ ref: r.ref, direction: "A2B" }));
    expect(h.broker.sessionInfo(r.ref)).not.toBeNull(); // A-side cuts must not masquerade as a-dropped
    expect(h.commands.filter((c) => c.cmd.type === "ssh_relay_close")).toHaveLength(0);
    // The lifetime cap still ends it.
    await h.advance(SSH_RELAY_LIFETIME_MS);
    expect(h.broker.sessionInfo(r.ref)).toBeNull();
    expect(h.audits[1]?.meta.reason).toBe("lifetime-expiry");
  });
});

/* ------------------------------------------------------------------ */
/* §5.6 teardown cuts, each with its named reason                      */
/* ------------------------------------------------------------------ */

describe("teardown (spec §5.6, Task 8 (f))", () => {
  it("lifetime expiry cuts with lifetime-expiry, tells both sides, audits once", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    await h.advance(SSH_RELAY_LIFETIME_MS);
    expect(h.broker.sessionInfo(r.ref)).toBeNull();
    const closes = h.commands.filter((c) => c.cmd.type === "ssh_relay_close");
    expect(closes.map((c) => c.nodeId).sort()).toEqual(["a", "b"]);
    for (const c of closes) expect(c.cmd).toEqual({ type: "ssh_relay_close", ref: r.ref, reason: "lifetime-expiry" });
    expect(h.audits.map((a) => a.action)).toEqual(["node.ssh_relay.open", "node.ssh_relay.close"]);
    expect(h.audits[1]?.meta).toMatchObject({ ref: r.ref, relayId: r.relayId, reason: "lifetime-expiry" });
  });

  it("the grace window elapsed without both sides cuts with handshake-grace", async () => {
    let releaseB: ((v: unknown) => void) | undefined;
    const h = makeHarness({
      ack: (nodeId, cmd) => {
        if (nodeId === "b" && cmd.type === "ssh_relay_open") {
          return new Promise((resolve) => {
            releaseB = resolve;
          });
        }
        return cmd.type === "ssh_relay_open" ? { role: "A", relayId: cmd.relayId } : { ok: true };
      },
    });
    const opening = h.open();
    await new Promise((r) => setTimeout(r, 0));
    // A answered; B has not, inside the grace: the session survives.
    const opened = h.commands.find((c) => c.cmd.type === "ssh_relay_open");
    const ref = opened?.cmd.type === "ssh_relay_open" ? opened.cmd.ref : "";
    expect(ref).not.toBe("");
    await h.advance(SSH_RELAY_TEARDOWN_GRACE_MS);
    expect(h.broker.sessionInfo(ref)).toBeNull();
    expect(
      h.commands.some(
        (c) => c.cmd.type === "ssh_relay_close" && (c.cmd as { reason: string }).reason === "handshake-grace",
      ),
    ).toBe(true);
    // B's late ack lands on a session that no longer exists: it must not
    // resurrect it and openRelay refuses loudly (the handshake never completed).
    releaseB?.({ role: "B", socketPath: buildAgentSocketPath("/data/b", PANE) });
    await expect(opening).rejects.toMatchObject({ code: "handshake" });
    expect(h.broker.sessionInfo(ref)).toBeNull();
  });

  it("a refusing node cuts the session under handshake-grace and openRelay throws the named reason", async () => {
    const h = makeHarness({
      ack: (_nodeId, cmd) => {
        if (cmd.type === "ssh_relay_open" && cmd.role === "B") throw new Error("machine pin for a has MOVED");
        return { role: "A", relayId: cmd.type === "ssh_relay_open" ? cmd.relayId : "" };
      },
    });
    await expect(h.open()).rejects.toMatchObject({ code: "handshake" });
    expect(h.broker.activeRelayCount("a")).toBe(0);
    const closes = h.commands.filter((c) => c.cmd.type === "ssh_relay_close");
    expect(closes).toHaveLength(2);
    const firstClose = closes[0];
    expect(firstClose?.cmd.type).toBe("ssh_relay_close");
    if (firstClose?.cmd.type === "ssh_relay_close") expect(firstClose.cmd.reason).toBe("handshake-grace");
  });

  it("share revocation closes only sessions whose user loses launch access", async () => {
    let revoked = false;
    const h = makeHarness({ relaySend: () => {}, authorize: async (userId) => !revoked || userId !== "g-target" });
    const r1 = await h.open({ paneId: "p1", userId: "g-target" });
    const r2 = await h.open({ paneId: "p2", userId: "g-keep" });
    revoked = true;
    const n = await h.broker.closeUnauthorizedForNode("a");
    expect(n).toBe(1);
    expect(h.broker.sessionInfo(r1.ref)).toBeNull();
    expect(h.broker.sessionInfo(r2.ref)).not.toBeNull();
    const closes = h.commands.filter((c) => c.cmd.type === "ssh_relay_close");
    expect(closes).toHaveLength(2);
    for (const c of closes) expect(c.cmd).toEqual({ type: "ssh_relay_close", ref: r1.ref, reason: "access-revoked" });
    expect(h.audits.filter((a) => a.action === "node.ssh_relay.close")).toHaveLength(1);
  });

  it("A's authenticated socket dropping cuts A's sessions with a-dropped and leaves B-side sessions alone", async () => {
    const h = makeHarness({
      relaySend: () => {},
      rows: {
        a: { kind: "agent", sshEnabled: 1 },
        b: { kind: "agent", sshEnabled: 1 },
        c: { kind: "agent", sshEnabled: 1 },
      },
    });
    const asA = await h.open({ paneId: "p1" });
    // Same node as B of another pairing: its socket close is NOT a cut
    // (§5.6 names only A-dropping; B's loss cuts via child-exit or the caps).
    const asB = await h.open({ paneId: "p2", aNode: "c", bNode: "a" });
    const closed = await h.broker.onNodeSocketClosed("a");
    expect(closed).toBe(1);
    expect(h.broker.sessionInfo(asA.ref)).toBeNull();
    expect(h.broker.sessionInfo(asB.ref)).not.toBeNull();
    expect(
      h.commands.some(
        (c) =>
          c.cmd.type === "ssh_relay_close" && c.nodeId === "b" && (c.cmd as { reason: string }).reason === "a-dropped",
      ),
    ).toBe(true);
  });

  it("child exit cuts by paneId; the sweep helper is best-effort and takes the row's id", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    const n = await h.broker.closeForPane(PANE, "child-exit");
    expect(n).toBe(1);
    expect(h.broker.sessionInfo(r.ref)).toBeNull();
    expect(
      h.commands.some((c) => c.cmd.type === "ssh_relay_close" && (c.cmd as { reason: string }).reason === "child-exit"),
    ).toBe(true);
    // An unknown pane is a no-op (the sweep runs on every death transition).
    expect(await h.broker.closeForPane("pane-nothing", "child-exit")).toBe(0);
    // The row-shaped sweep fires through the module singleton without throwing.
    setRelayBrokerForTests(h.broker);
    try {
      sweepRelayForPane({ id: "pane-nothing" });
      closeRelayForPaneExit("pane-nothing");
      closeRelayForPaneExit(null);
    } finally {
      setRelayBrokerForTests(null);
    }
  });

  it("an over-cap frame closes the session it names, by name, and the blob never comes along", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    expect(await h.broker.refuseOverCap(r.ref)).toBe(true);
    expect(
      h.commands.some((c) => c.cmd.type === "ssh_relay_close" && (c.cmd as { reason: string }).reason === "over-cap"),
    ).toBe(true);
    expect(h.broker.sessionInfo(r.ref)).toBeNull();
    expect(JSON.stringify(h.audits)).not.toContain("over-cap-blob-bytes");
    expect(await h.broker.refuseOverCap("r-unknown")).toBe(false);
  });

  it("closeRelay is idempotent: the second cut answers false and fires no second audit", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    expect(await h.broker.closeRelay(r.ref, "lifetime-expiry")).toBe(true);
    expect(await h.broker.closeRelay(r.ref, "lifetime-expiry")).toBe(false);
    expect(h.audits.filter((a) => a.action === "node.ssh_relay.close")).toHaveLength(1);
    // An unknown reason never leaves the plane either.
    expect(await h.broker.closeRelay("r-none", "not-a-reason" as SshRelayCloseReason)).toBe(false);
  });

  it("teardown keeps the close command's own failure from poisoning anything", async () => {
    const h = makeHarness({
      relaySend: () => {},
      ack: (_nodeId, cmd) => {
        if (cmd.type === "ssh_relay_close") throw new Error("node offline");
        return cmd.type === "ssh_relay_open" && cmd.role === "B"
          ? { socketPath: buildAgentSocketPath("/data/b", cmd.paneId) }
          : { ok: true };
      },
    });
    const r = await h.open();
    await expect(h.broker.closeRelay(r.ref, "access-revoked")).resolves.toBe(true);
    expect(h.broker.sessionInfo(r.ref)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* audit hygiene, pane env, and the real per-node send glue            */
/* ------------------------------------------------------------------ */

describe("audit hygiene (Global Constraints)", () => {
  it("open/close rows carry ids, hosts and the reason ONLY - never keys, fingerprints, or payloads", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    h.broker.routeRelayFrame("b", frame({ ref: r.ref }));
    await h.advance(SSH_RELAY_LIFETIME_MS);
    const serialized = JSON.stringify(h.audits);
    for (const secret of [A_SIGNING, B_SIGNING, A_ENCRYPT, B_ENCRYPT, "SHA256:AAAA", "QUJDk5", r.socketPath]) {
      expect(serialized).not.toContain(secret);
    }
    // fingerprint COUNT, never the set.
    expect(h.audits[0]?.meta.fingerprintCount).toBe(2);
    expect(h.audits[0]?.meta.fingerprints).toBeUndefined();
  });
});

describe("SSH_AUTH_SOCK scoping (acceptance (e))", () => {
  it("the relay pane env is EXACTLY the one-key scoped exception, nothing else", async () => {
    const h = makeHarness({ relaySend: () => {} });
    const r = await h.open();
    expect(sshRelayPaneEnv(r.socketPath)).toEqual({ SSH_AUTH_SOCK: `/data/b/ssh/${PANE}/agent.sock` });
    // A caller cannot smuggle a second variable through the seam.
    expect(Object.keys(sshRelayPaneEnv("x"))).toEqual(["SSH_AUTH_SOCK"]);
  });
});

describe("sendRelayFrameOverNodeSocket (the plane's throw-on-drop glue, acceptance (c))", () => {
  it("throws when the node has no live connection", () => {
    resetNodeRegistryForTests();
    expect(() => sendRelayFrameOverNodeSocket("gone", frame())).toThrow(RelaySendError);
  });

  it("throws on a closing or link-less connection and seals onto a live one", () => {
    resetNodeRegistryForTests();
    const sent: (string | Buffer)[] = [];
    const ws: NodeSocket = {
      send: (d) => {
        sent.push(d);
      },
      close: () => {},
    };
    const conn = attachConnection("n1", ws);
    // No link yet (the handshake window, or a hand-built conn): a relay
    // frame is NEVER written plaintext.
    expect(() => sendRelayFrameOverNodeSocket("n1", frame({ ref: "r-1" }))).toThrow(RelaySendError);
    conn.link = {
      sealFrame: (s: string) => new TextEncoder().encode(`SEALED:${s}`),
    } as never;
    sendRelayFrameOverNodeSocket("n1", frame({ ref: "r-1" }));
    expect(sent).toHaveLength(1);
    expect(Buffer.isBuffer(sent[0])).toBe(true);
    // The Buffer carries the SEALED envelope, not the plaintext frame.
    expect((sent[0] as Buffer).toString("utf8")).toContain("SEALED:");
    // Closing / superseded conns throw too.
    conn.closing = true;
    expect(() => sendRelayFrameOverNodeSocket("n1", frame({ ref: "r-1" }))).toThrow(RelaySendError);
    resetNodeRegistryForTests();
    expect(getLive("n1")).toBeUndefined();
  });

  it("a throwing socket send surfaces as the named RelaySendError (never silence)", () => {
    resetNodeRegistryForTests();
    const ws: NodeSocket = {
      send: () => {
        throw new Error("socket write failed");
      },
      close: () => {},
    };
    const conn = attachConnection("n2", ws);
    conn.link = { sealFrame: () => new Uint8Array([1]) } as never;
    expect(() => sendRelayFrameOverNodeSocket("n2", frame())).toThrow(RelaySendError);
    resetNodeRegistryForTests();
  });
});

describe("grammar/version posture", () => {
  it("relays a protocol-19-only world: the constant is pinned here as the broker's precondition", () => {
    // The handler refuses every relay frame from a pre-18 agent upstream;
    // this tripwire documents the dependency at the broker.
    expect(NODE_PROTOCOL_VERSION).toBe(19);
  });
});

describe("identity repair excludes concurrent and stale opens", () => {
  it("holds the barrier through deferred closes and registration/cache replacement", async () => {
    const closing = Promise.withResolvers<void>();
    const closeAck = Promise.withResolvers<void>();
    const replacing = Promise.withResolvers<void>();
    const replacement = Promise.withResolvers<void>();
    const h = makeHarness({
      ack: async (_nodeId, cmd) => {
        if (cmd.type === "ssh_relay_close") {
          closing.resolve();
          await closeAck.promise;
        }
        return cmd.type === "ssh_relay_open" && cmd.role === "B"
          ? { socketPath: buildAgentSocketPath("/data/b", cmd.paneId) }
          : { ok: true };
      },
    });
    const stale = { a: h.broker.identityGeneration("a"), b: h.broker.identityGeneration("b") };
    const session = await h.open();
    const repair = h.broker.withNodeIdentityRepair("a", async () => {
      replacing.resolve();
      await replacement.promise;
    });
    await closing.promise;
    await expect(h.open()).rejects.toMatchObject({ code: "identity-repair" });
    await expect(h.broker.withNodeIdentityRepair("a", async () => {})).rejects.toMatchObject({
      code: "identity-repair",
    });
    closeAck.resolve();
    await replacing.promise;
    const during = { a: h.broker.identityGeneration("a"), b: h.broker.identityGeneration("b") };
    await expect(h.open()).rejects.toMatchObject({ code: "identity-repair" });
    replacement.resolve();
    await repair;
    expect(h.broker.sessionInfo(session.ref)).toBeNull();
    expect(h.broker.activeRelayCount("a")).toBe(0);
    await expect(h.open({ identityGenerations: stale })).rejects.toMatchObject({ code: "identity-repair" });
    await expect(h.open({ identityGenerations: during })).rejects.toMatchObject({ code: "identity-repair" });
    await h.open();
    expect(h.broker.activeRelayCount("a")).toBe(1);
    await h.broker.shutdown();
  });

  it("waits for a close already draining outside the routable session map", async () => {
    const closing = Promise.withResolvers<void>();
    const closeAck = Promise.withResolvers<void>();
    const h = makeHarness({
      ack: async (_nodeId, cmd) => {
        if (cmd.type === "ssh_relay_close") {
          closing.resolve();
          await closeAck.promise;
        }
        return cmd.type === "ssh_relay_open" && cmd.role === "B"
          ? { socketPath: buildAgentSocketPath("/data/b", cmd.paneId) }
          : { ok: true };
      },
    });
    const opened = await h.open();
    const close = h.broker.closeRelay(opened.ref, "child-exit");
    await closing.promise;
    let replaced = false;
    const repair = h.broker.withNodeIdentityRepair("a", async () => {
      replaced = true;
    });
    await expect(h.open()).rejects.toMatchObject({ code: "identity-repair" });
    expect(replaced).toBe(false);
    closeAck.resolve();
    await Promise.all([close, repair]);
    expect(replaced).toBe(true);
    expect(h.broker.activeRelayCount("a")).toBe(0);
  });

  it("invalidates an open still awaiting authorization before it creates a session", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<boolean>();
    const h = makeHarness({
      authorize: async () => {
        entered.resolve();
        return gate.promise;
      },
    });
    const opening = h.open();
    await entered.promise;
    await h.broker.withNodeIdentityRepair("b", async () => {});
    gate.resolve(true);
    await expect(opening).rejects.toMatchObject({ code: "identity-repair" });
    expect(h.commands).toEqual([]);
    expect(h.broker.activeRelayCount("a")).toBe(0);
  });

  it("cuts pending handshakes and refuses their late open acknowledgments", async () => {
    const entered = Promise.withResolvers<void>();
    const openAck = Promise.withResolvers<void>();
    const participants = new Set<string>();
    const h = makeHarness({
      ack: async (nodeId, cmd) => {
        if (cmd.type === "ssh_relay_open") {
          participants.add(nodeId);
          entered.resolve();
          await openAck.promise;
          return cmd.role === "B" ? { socketPath: buildAgentSocketPath("/data/b", cmd.paneId) } : { ok: true };
        }
        if (cmd.type === "ssh_relay_close") participants.delete(nodeId);
        return { ok: true };
      },
    });
    const opening = h.open();
    await entered.promise;
    await h.broker.withNodeIdentityRepair("a", async () => {});
    expect(participants.size).toBe(0);
    openAck.resolve();
    await expect(opening).rejects.toMatchObject({ code: "identity-repair" });
    expect(h.broker.activeRelayCount("a")).toBe(0);
  });

  it("releases the barrier after a failed replacement while invalidating prepared keys", async () => {
    const h = makeHarness();
    const stale = { a: h.broker.identityGeneration("a"), b: h.broker.identityGeneration("b") };
    await expect(
      h.broker.withNodeIdentityRepair("a", async () => {
        throw new Error("registration failed");
      }),
    ).rejects.toThrow("registration failed");
    await expect(h.open({ identityGenerations: stale })).rejects.toMatchObject({ code: "identity-repair" });
    await h.open();
    await h.broker.shutdown();
  });
});

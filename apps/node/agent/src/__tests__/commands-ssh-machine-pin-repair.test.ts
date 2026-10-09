import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshMachinePinRepairCommand } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execSshMachinePinRepair } from "../commands/ssh-machine-pin-repair.js";
import { MachinePinStore, machinePinPath } from "../machine-pin-store.js";
import { writeSshEnabled } from "../ssh-enabled.js";

/**
 * The §4.5 re-pair arm (spec 2026-10-08 §4.5, Task 17). Posture copied from
 * commands-ssh-relay.test.ts: a real temp data dir, the store read back
 * through its own class, refusals asserted by `ok:false` + message.
 *
 * What THIS file owns:
 * - the dispatch arm exists (never the switch's `unsupported`) and the write
 *   lands: after a valid repair, `check()` for the delivered pair is `ok`
 *   (the §13 block-clears keystone, at the COMMAND layer; the store-level
 *   pair lives in machine-pin-store.test.ts).
 * - the arm is UNGATED by design (the `ssh_register_identity` precedent): a
 *   machine whose ssh-enabled mirror is OFF still repairs its trust record,
 *   because the recovery must reach a machine whose pairing is blocked.
 * - deep key validation BEFORE any write: a private (`d`-bearing) JWK in
 *   either half is refused with the store untouched - the base64 encryption
 *   half is where the grammar cannot see, so this handler is the station
 *   that refuses it.
 * - replace-or-add: a peer with no entry gets one (a lost store re-pairs).
 * - the ack carries {repaired, peerNodeId} and NOTHING else - no key bytes
 *   ride the result frame, and no audit row exists on this machine (the
 *   trail is the plane's `node.ssh_machine_pin.repair`, ids only).
 */

const SELF = "node-self";
const PEER = "node-peer";

/** Real-length P-256 coordinate text (bytesOfJwk demands 32 decoded bytes). */
const coord = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");
const publicJwk = (fill: number, extra: Record<string, string> = {}): string =>
  JSON.stringify({ kty: "EC", crv: "P-256", x: coord(fill), y: coord(fill + 10), ...extra });
const b64 = (jwkJson: string): string => Buffer.from(jwkJson, "utf8").toString("base64");

const SIGN_OK = publicJwk(1);
const ENC_OK = publicJwk(50);
/** A serialized PRIVATE JWK of the same public shape: the top-level `d`. */
const SIGN_PRIVATE = publicJwk(1, { d: coord(99) });
const ENC_PRIVATE = publicJwk(50, { d: coord(77) });

let base: string | null = null;
function freshDataDir(tag: string, opts: { gateOn?: boolean } = {}): string {
  base ??= tmpdir();
  const dir = mkdtempSync(join(base, `subshell-repair-${tag}-`));
  if (opts.gateOn) writeSshEnabled(dir, { on: true, changedAt: "2026-10-08T10:00:00.000Z" });
  return dir;
}

function makeCtx(dataDir: string, nodeId: string = SELF): CommandContext {
  return { config: { dataDir, nodeId } } as unknown as CommandContext;
}

function repairCmd(over: Partial<SshMachinePinRepairCommand> = {}): SshMachinePinRepairCommand {
  return {
    type: "ssh_machine_pin_repair",
    peerNodeId: PEER,
    peerSigningPublicKey: SIGN_OK,
    peerEncryptPublicKey: b64(ENC_OK),
    ...over,
  };
}

describe("ssh_machine_pin_repair dispatch (the arm exists, the write lands)", () => {
  it("a valid re-pair replaces the blocked entry and check() clears, through the real switch", async () => {
    const dir = freshDataDir("write", { gateOn: true });
    const store = new MachinePinStore(dir);
    // The blocked state first: the peer's key moved, byte-strict refuses.
    store.pin(PEER, { signing: publicJwk(90), encryption: publicJwk(110) });
    expect(store.check(PEER, { signing: SIGN_OK, encryption: ENC_OK })).toBe("changed");
    const res = await dispatchCommand(makeCtx(dir), repairCmd());
    expect(res).toEqual({ ok: true, data: { repaired: true, peerNodeId: PEER } });
    expect(store.check(PEER, { signing: SIGN_OK, encryption: ENC_OK })).toBe("ok");
    // Bytes are stored EXACTLY as delivered (the registration spelling):
    // the pin round-trips byte-for-byte, not a re-serialization.
    expect(store.get(PEER)).toEqual({ signing: SIGN_OK, encryption: ENC_OK });
  });

  it("a peer with no stored entry gets one (a repair after a lost store)", async () => {
    const dir = freshDataDir("add", { gateOn: true });
    const store = new MachinePinStore(dir);
    expect(store.get(PEER)).toBe(null);
    expect(await dispatchCommand(makeCtx(dir), repairCmd())).toEqual({
      ok: true,
      data: { repaired: true, peerNodeId: PEER },
    });
    expect(store.check(PEER, { signing: SIGN_OK, encryption: ENC_OK })).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the gate does NOT speak here: a machine with the mirror OFF still repairs its trust record", async () => {
    // Deliberate, the `ssh_register_identity` doctrine: re-pair is a
    // trust-record act on this machine's own store, and §4.5 recovery must
    // reach a machine whose pairing is currently blocked. A GATED arm would
    // make the repair of a relationship depend on the relationship.
    const dir = freshDataDir("ungated"); // no writeSshEnabled: mirror absent
    const res = await dispatchCommand(makeCtx(dir), repairCmd());
    expect(res.ok).toBe(true);
    expect(new MachinePinStore(dir).get(PEER)).not.toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deep key validation before any write (the grammar cannot see inside base64)", () => {
  function refused(dir: string, cmd: SshMachinePinRepairCommand): void {
    const res = execSshMachinePinRepair(makeCtx(dir), cmd);
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain("peer key rejected");
  }

  it("refuses a PRIVATE encryption JWK carried in base64, with the store untouched", () => {
    // THE deep refusal this arm owns: the outer grammar proves the base64
    // shape but cannot read the JSON inside, so `d` inside the delivered
    // encryption half is caught HERE - and nothing was written.
    const dir = freshDataDir("enc-private");
    refused(dir, repairCmd({ peerEncryptPublicKey: b64(ENC_PRIVATE) }));
    expect(new MachinePinStore(dir).get(PEER)).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a `d`-bearing signing JWK and foreign-curve / junk halves alike", () => {
    for (const [tag, over] of [
      ["sign-d", { peerSigningPublicKey: SIGN_PRIVATE }],
      ["sign-junk", { peerSigningPublicKey: "not json" }],
      ["sign-short-coords", { peerSigningPublicKey: '{"kty":"EC","crv":"P-256","x":"AX","y":"AY"}' }],
      ["sign-wrong-kty", { peerSigningPublicKey: '{"kty":"OKP","crv":"Ed25519","x":"AX"}' }],
      ["enc-junk", { peerEncryptPublicKey: b64("hello") }],
      [
        "enc-wrong-curve",
        { peerEncryptPublicKey: b64(`{"kty":"EC","crv":"P-384","x":"${coord(3)}","y":"${coord(4)}"}`) },
      ],
    ] as const) {
      const dir = freshDataDir(tag);
      refused(dir, repairCmd(over as Partial<SshMachinePinRepairCommand>));
      expect(new MachinePinStore(dir).get(PEER)).toBe(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a refusal writes NOTHING: an existing pin for the peer survives verbatim", () => {
    const dir = freshDataDir("no-partial");
    const store = new MachinePinStore(dir);
    store.pin(PEER, { signing: SIGN_OK, encryption: ENC_OK });
    refused(dir, repairCmd({ peerEncryptPublicKey: b64(ENC_PRIVATE) }));
    expect(store.get(PEER)).toEqual({ signing: SIGN_OK, encryption: ENC_OK });
    rmSync(dir, { recursive: true, force: true });
  });

  it("a corrupt pin store fail-closes the repair instead of silently rewriting it", () => {
    const dir = freshDataDir("corrupt");
    writeFileSync(machinePinPath(dir), "{ not json");
    const res = execSshMachinePinRepair(makeCtx(dir), repairCmd());
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain("machine pin repair refused");
    // The store's quarantine doctrine ran (throws, moves the file aside);
    // the delivered pair never landed as a fresh store.
    expect(new MachinePinStore(dir).get(PEER)).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a repair naming THIS machine as its own peer", () => {
    const dir = freshDataDir("self-peer");
    const res = execSshMachinePinRepair(makeCtx(dir), repairCmd({ peerNodeId: SELF }));
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain("never its own relay peer");
    expect(new MachinePinStore(dir).get(SELF)).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the ack carries ids only (no key material, no audit here)", () => {
  it("the success data is exactly {repaired, peerNodeId}; the pin bytes appear nowhere in it", () => {
    const dir = freshDataDir("ack-shape", { gateOn: true });
    const res = execSshMachinePinRepair(makeCtx(dir), repairCmd());
    expect(res.ok).toBe(true);
    if (res.ok !== true) return;
    const serialized = JSON.stringify(res.data);
    expect(res.data).toEqual({ repaired: true, peerNodeId: PEER });
    // Belt for the no-key-material constraint: the delivered halves (raw and
    // base64 spellings) cannot appear in the answer the plane receives.
    expect(serialized).not.toContain(SIGN_OK);
    expect(serialized).not.toContain(b64(ENC_OK));
    expect(serialized).not.toContain(coord(1));
    // The bytes live exactly one place on this machine: the pin file itself.
    expect(readFileSync(machinePinPath(dir), "utf8")).toContain(coord(1));
  });

  it("a refusal names the problem without echoing the delivered key material", () => {
    const dir = freshDataDir("refusal-hygiene");
    const res = execSshMachinePinRepair(makeCtx(dir), repairCmd({ peerEncryptPublicKey: b64(ENC_PRIVATE) }));
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      // The error rides the RESULT channel and the plane may log it: the node
      // refuses by SHAPE, never by quoting what was refused (T8 posture).
      expect(res.error).not.toContain(ENC_PRIVATE);
      expect(res.error).not.toContain(b64(ENC_PRIVATE));
      expect(res.error).not.toContain(coord(60));
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

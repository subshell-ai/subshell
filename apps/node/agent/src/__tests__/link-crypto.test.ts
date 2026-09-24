import { describe, expect, test } from "bun:test";
import { NODE_CLOSE_HANDSHAKE_REQUIRED, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import {
  createServerSession,
  ensureSodium,
  generateLinkKeyPair,
  type LinkKeyPair,
  parseKxFrame,
  parseLinkBinding,
  parseRegisterFrame,
  parseRegisterOkFrame,
} from "@internal/subshell-protocol/node-link-crypto";
import type { NodeConfig } from "../config.js";
import { binaryPayload, createLinkNegotiator, type LinkNegotiatorArgs } from "../link-crypto.js";

/**
 * The client half of the /ws/node link handshake (spec 2026-09-24 §4/§5),
 * driven against fake sockets with REAL libsodium on both ends — the same
 * posture as the server machine's suite: the frames that leave this module
 * are proven by the SERVER's own validators, and the ack the module must
 * accept is sealed by a real `createServerSession`.
 */

/** The socket surface the negotiator touches; records everything it emits. */
class FakeWs {
  readonly sends: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  /** EVERY inbound frame the fake plane pushed at the negotiator. Stays 0 through the R6 assertion. */
  inbound = 0;
  send(data: string | Uint8Array): void {
    this.sends.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

function baseConfig(over: Partial<NodeConfig> = {}): NodeConfig {
  return {
    serverUrl: "http://plane.test",
    nodeId: "node-1",
    nodeKey: "node-key-live",
    controlPublicKey: "{}",
    dataDir: "/tmp/link-crypto-test",
    name: "test",
    ...over,
  };
}

interface Harness {
  negotiator: ReturnType<typeof createLinkNegotiator>;
  logs: string[];
  patches: Array<Partial<NodeConfig>>;
  established: number;
}

function makeHarness(args: Partial<LinkNegotiatorArgs> & { config: NodeConfig }): Harness {
  const logs: string[] = [];
  const patches: Array<Partial<NodeConfig>> = [];
  let established = 0;
  const negotiator = createLinkNegotiator({
    log: (m) => void logs.push(m),
    persist: async (patch) => {
      patches.push(patch);
      Object.assign(args.config, patch); // mirrors the daemon's live-config write-back
    },
    onEstablished: () => {
      established++;
    },
    ...args,
  });
  return {
    negotiator,
    logs,
    patches,
    get established() {
      return established;
    },
  };
}

async function serverFixture(): Promise<LinkKeyPair> {
  return generateLinkKeyPair();
}

/** Drive a handshake-mode negotiator to `kx` + binding and return the server-side view of it. */
async function beginHandshake(pair: LinkKeyPair, serverStatic: LinkKeyPair) {
  const ws = new FakeWs();
  const h = makeHarness({
    config: baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: serverStatic.publicKey }),
  });
  await h.negotiator.begin(ws);
  const kx = parseKxFrame(JSON.parse(ws.sends[0] as string));
  if (!kx) throw new Error(`first send was not a kx frame: ${String(ws.sends[0]).slice(0, 120)}`);
  const session = await createServerSession({ serverStatic, clientEphemeralPublicKey: kx.eph });
  return { ws, h, kx, session };
}

describe("handshake mode (config provisioned)", () => {
  test("kx + binding are pushed back-to-back with NOTHING inbound (R6: no server kx reply)", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h, kx, session } = await beginHandshake(pair, serverStatic);

    // THE R6 correction, pinned: by the time the binding is on the wire the fake
    // plane has sent nothing at all. A client that waited for a server `kx`
    // reply could not produce this state.
    expect(ws.inbound).toBe(0);
    expect(ws.sends.length).toBe(2);

    // Frame 1: text kx — `eph` fresh, `pub` the LONG-TERM claim from config.
    expect(kx.pub).toBe(pair.publicKey);
    expect(typeof ws.sends[0]).toBe("string");

    // Frame 2: the encrypted binding, already ciphertext, NOT a reply to anything.
    expect(ws.sends[1]).toBeInstanceOf(Uint8Array);
    const opened = session.openFrame(ws.sends[1] as Uint8Array);
    expect(opened).not.toBeNull();
    expect(parseLinkBinding(JSON.parse(opened as string))).toEqual({
      nodeId: "node-1",
      nodeKey: "node-key-live",
      protocolVersion: NODE_PROTOCOL_VERSION,
    });

    // Not established until the sealed ack opens.
    expect(h.negotiator.established()).toBe(false);
    expect(h.established).toBe(0);

    // The server's first push, the sealed {t:"ok"}: opens → established, consumed.
    const ack = session.sealFrame(JSON.stringify({ t: "ok" }));
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, ack)).toBeNull();
    expect(h.negotiator.established()).toBe(true);
    expect(h.established).toBe(1);
    expect(ws.closes).toEqual([]);
    // The session is what the daemon's send path seals through.
    expect(h.negotiator.session()).toBeDefined();
  });

  test("the ephemeral is FRESH per connection; the long-term pub is the config pair", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const a = await beginHandshake(pair, serverStatic);
    const b = await beginHandshake(pair, serverStatic);
    expect(a.kx.eph).not.toBe(b.kx.eph);
    expect(a.kx.pub).toBe(pair.publicKey);
    expect(b.kx.pub).toBe(pair.publicKey);
  });

  test("a first inbound frame that will not open closes 4410 (the pinned server key is wrong)", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h } = await beginHandshake(pair, serverStatic);
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(ws.closes.length).toBe(1);
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.negotiator.established()).toBe(false);
    expect(h.established).toBe(0);
  });

  test("an ack sealed by the WRONG server key closes 4410", async () => {
    const serverStatic = await serverFixture();
    const impostor = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h } = await beginHandshake(pair, serverStatic);
    // Seal with an UNRELATED session (impostor static, unrelated eph): the
    // bytes are well-formed secretstream but cannot open against the keys the
    // node derived from its pin — exactly what a wrong pin produces on the wire.
    const unrelated = await createServerSession({
      serverStatic: impostor,
      clientEphemeralPublicKey: (await generateLinkKeyPair()).publicKey,
    });
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, unrelated.sealFrame(JSON.stringify({ t: "ok" })))).toBeNull();
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
  });

  test("bytes that open to something OTHER than {t:'ok'} close 4410", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h, session } = await beginHandshake(pair, serverStatic);
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, session.sealFrame(JSON.stringify({ t: "nope" })))).toBeNull();
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.established).toBe(0);
  });

  test("a plaintext frame before the ack closes 4410 (spec §6: never plaintext once classified)", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h } = await beginHandshake(pair, serverStatic);
    ws.inbound++;
    h.negotiator.onTextFrame(ws, JSON.stringify({ type: "heartbeat" }));
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
  });

  test("a plaintext frame AFTER established closes 4410, not forwarded", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h, session } = await beginHandshake(pair, serverStatic);
    ws.inbound++;
    h.negotiator.onBytesFrame(ws, session.sealFrame(JSON.stringify({ t: "ok" })));
    expect(h.negotiator.established()).toBe(true);
    ws.inbound++;
    h.negotiator.onTextFrame(ws, JSON.stringify({ type: "heartbeat" }));
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
  });

  test("undecryptable bytes AFTER established close 4410 — the stream is dead, never resynced", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const { ws, h, session } = await beginHandshake(pair, serverStatic);
    ws.inbound++;
    h.negotiator.onBytesFrame(ws, session.sealFrame(JSON.stringify({ t: "ok" })));
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, new Uint8Array([9, 9, 9]))).toBeNull();
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
  });

  test("ciphertext BEFORE the kx derivation finished closes 4410 (wrong kind, wrong phase)", async () => {
    const ws = new FakeWs();
    const pair = await generateLinkKeyPair();
    const serverStatic = await serverFixture();
    const h = makeHarness({
      config: baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: serverStatic.publicKey }),
    });
    h.negotiator.begin(ws); // NOT awaited: the plane answers before derivation lands
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, new Uint8Array([1, 2, 3]))).toBeNull();
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    await new Promise((r) => setTimeout(r, 50)); // let begin settle past the refused socket
    expect(h.negotiator.established()).toBe(false);
  });

  test("a junk pinned key fails LOUDLY: no crash, a log line naming it, a close", async () => {
    const ws = new FakeWs();
    const pair = await generateLinkKeyPair();
    const h = makeHarness({
      config: baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: "not-a-valid-key!!" }),
    });
    await h.negotiator.begin(ws);
    expect(ws.sends).toEqual([]);
    expect(ws.closes.length).toBe(1);
    expect(h.logs.some((l) => l.includes("handshake failed"))).toBe(true);
  });
});

describe("legacy register self-heal (spec §5)", () => {
  test("no keys → keypair saved FIRST, then register with its pub; register-ok saves the pin and closes", async () => {
    const serverStatic = await serverFixture();
    const ws = new FakeWs();
    const config = baseConfig();
    const h = makeHarness({ config });
    await h.negotiator.begin(ws);

    expect(h.patches.length).toBe(1); // the pair is stored BEFORE the frame is sent
    const stored = h.patches[0]?.encryptKeyPair as LinkKeyPair;
    expect(typeof stored?.publicKey).toBe("string");
    expect(typeof stored?.privateKey).toBe("string");
    const register = parseRegisterFrame(JSON.parse(ws.sends[0] as string));
    expect(register?.pub).toBe(stored.publicKey);

    // The plane's answer: pin saved (the pair already is), then a NORMAL close for the redial.
    ws.inbound++;
    h.negotiator.onTextFrame(ws, JSON.stringify({ t: "register-ok", controlEncryptPublicKey: serverStatic.publicKey }));
    await new Promise((r) => setTimeout(r, 50)); // the persist is async
    expect(h.patches.length).toBe(2);
    expect(h.patches[1]).toEqual({ controlEncryptPublicKey: serverStatic.publicKey });
    expect(ws.closes.length).toBe(1);
    expect(ws.closes[0]?.code).toBeUndefined(); // NOT 4410 — R7's normal close
    expect(h.established).toBe(0); // this socket never handshakes; the NEXT one does
  });

  test("the SAME static is reused across reconnects while the pin is missing (register continuation)", async () => {
    const ws1 = new FakeWs();
    const config = baseConfig();
    const h1 = makeHarness({ config });
    await h1.negotiator.begin(ws1);
    const firstPub = parseRegisterFrame(JSON.parse(ws1.sends[0] as string))?.pub;
    expect(firstPub).toBeDefined();

    // register-ok NEVER LANDS; the daemon redials. The config (mutated by the
    // persist write-back) now carries the pair but no pin — a continuation,
    // not a fresh mint: the plane may already have pinned this pub.
    const ws2 = new FakeWs();
    const h2 = makeHarness({ config });
    await h2.negotiator.begin(ws2);
    expect(parseRegisterFrame(JSON.parse(ws2.sends[0] as string))?.pub).toBe(firstPub);
    expect(h2.patches).toEqual([]); // pair already on disk: not re-saved
  });

  test("a register-ok arriving on a PROVISIONED config is refused 4410 and never clobbers the keys", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const ws = new FakeWs();
    const config = baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: serverStatic.publicKey });
    const h = makeHarness({ config });
    await h.negotiator.begin(ws); // handshake mode — a register-ok is the wrong kind here
    ws.inbound++;
    h.negotiator.onTextFrame(
      ws,
      JSON.stringify({ t: "register-ok", controlEncryptPublicKey: (await generateLinkKeyPair()).publicKey }),
    );
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.patches).toEqual([]);
    expect(config.encryptKeyPair).toEqual(pair); // the node's identity is untouched
    expect(config.controlEncryptPublicKey).toBe(serverStatic.publicKey);
  });

  test("a non-register-ok text frame on a legacy socket closes 4410", async () => {
    const ws = new FakeWs();
    const h = makeHarness({ config: baseConfig() });
    await h.negotiator.begin(ws);
    ws.inbound++;
    h.negotiator.onTextFrame(ws, JSON.stringify({ type: "heartbeat" }));
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
  });

  test("bytes on a socket with NO session are dropped, logged per frame, and never closed", async () => {
    const ws = new FakeWs();
    const h = makeHarness({ config: baseConfig() });
    await h.negotiator.begin(ws);
    // Every binary shape `admitFrame` hands over — Buffer and plain Uint8Array
    // (the ArrayBuffer spelling is normalized to a Uint8Array view upstream).
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, Buffer.alloc(3, 9))).toBeNull();
    ws.inbound++;
    expect(h.negotiator.onBytesFrame(ws, new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(ws.closes).toEqual([]);
    expect(h.logs.filter((l) => l.includes("ignored binary frame")).length).toBe(2);
  });

  test("a pin with no keypair cannot derive: a log line and a close, never a half-register", async () => {
    const ws = new FakeWs();
    const serverStatic = await serverFixture();
    const h = makeHarness({ config: baseConfig({ controlEncryptPublicKey: serverStatic.publicKey }) });
    await h.negotiator.begin(ws);
    expect(ws.sends).toEqual([]);
    expect(ws.closes.length).toBe(1);
    expect(h.logs.some((l) => l.includes("link identity incomplete"))).toBe(true);
  });

  test("a keypair saved for register is NEVER sent as the kx claim before a pin exists", async () => {
    // Half-provisioned the other way (pair, no pin) is the register continuation —
    // it registers, it must not fabricate a handshake from its own pair.
    const ws = new FakeWs();
    const pair = await generateLinkKeyPair();
    const h = makeHarness({ config: baseConfig({ encryptKeyPair: pair }) });
    await h.negotiator.begin(ws);
    expect(parseRegisterFrame(JSON.parse(ws.sends[0] as string))).not.toBeNull();
    expect(h.patches).toEqual([]); // already stored
  });

  test("a failed keypair store refuses BEFORE the register frame is sent — the plane never pins a key the node lost", async () => {
    const ws = new FakeWs();
    const h = makeHarness({
      config: baseConfig(),
      persist: async () => {
        throw new Error("disk full");
      },
    });
    await h.negotiator.begin(ws);
    expect(ws.sends).toEqual([]); // NOTHING reached the plane: nothing was pinned
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.logs.some((l) => l.includes("could not be stored") && l.includes("disk full"))).toBe(true);
  });

  test("a failed pin store is refused loudly, keeps the stored pair, and the next dial continues with the SAME static", async () => {
    const serverStatic = await serverFixture();
    const ws1 = new FakeWs();
    const config = baseConfig();
    let pinFail = false;
    const h = makeHarness({
      config,
      persist: async (patch) => {
        if (patch.controlEncryptPublicKey && pinFail) throw new Error("read-only disk");
        Object.assign(config, patch);
      },
    });
    await h.negotiator.begin(ws1); // the pair itself stored fine
    const storedPub = config.encryptKeyPair?.publicKey;
    expect(storedPub).toBeDefined();

    pinFail = true;
    ws1.inbound++;
    h.negotiator.onTextFrame(
      ws1,
      JSON.stringify({ t: "register-ok", controlEncryptPublicKey: serverStatic.publicKey }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(ws1.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED); // refused, error visible…
    expect(h.logs.some((l) => l.includes("read-only disk"))).toBe(true); // …never swallowed
    expect(config.controlEncryptPublicKey).toBeUndefined(); // nothing half-written

    // Recovery is the continuation, not a re-mint: the NEXT attempt registers
    // the pair that IS on disk — the plane's pin (if it landed) still matches.
    const ws2 = new FakeWs();
    const h2 = makeHarness({ config, persist: async () => undefined });
    await h2.negotiator.begin(ws2);
    expect(parseRegisterFrame(JSON.parse(ws2.sends[0] as string))?.pub).toBe(storedPub);
  });

  test("a register-ok whose key is not a 32-byte key is refused, and nothing is saved", async () => {
    const ws = new FakeWs();
    const h = makeHarness({ config: baseConfig() });
    await h.negotiator.begin(ws);
    ws.inbound++;
    h.negotiator.onTextFrame(ws, JSON.stringify({ t: "register-ok", controlEncryptPublicKey: "aGVsbG8" })); // "hello", 5 bytes
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.patches.filter((p) => "controlEncryptPublicKey" in p)).toEqual([]);
  });
});

describe("onClosed — R11: a plane 4410 BEFORE establishment drops the control pin", () => {
  /** Handshake-mode harness: kx + binding on the wire, ack never opened. */
  async function provisionedSocket() {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const config = baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: serverStatic.publicKey });
    const h = makeHarness({ config });
    const ws = new FakeWs();
    await h.negotiator.begin(ws);
    return { config, pair, serverStatic, h, ws };
  }

  test("handshake mode + plane-initiated 4410 + never established → persist EXACTLY {controlEncryptPublicKey: undefined}", async () => {
    const { config, pair, h } = await provisionedSocket();
    expect(h.negotiator.established()).toBe(false);

    h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED); // the R10 refusal, or the handshake timeout

    expect(h.patches).toHaveLength(1);
    const patch = h.patches[0] as Record<string, unknown>;
    // THE ruling, as a key set: the PIN only — the pair is not in the patch
    // at all, because §5's continuation rule reads pair-without-pin as
    // "register with what is already stored".
    expect(Object.keys(patch)).toEqual(["controlEncryptPublicKey"]);
    expect("controlEncryptPublicKey" in patch).toBe(true); // EXPLICIT undefined — the clear signal
    expect(patch.controlEncryptPublicKey).toBeUndefined();
    // The daemon mirrors patches onto the live config; the next begin() must
    // therefore classify register (pair kept, pin gone).
    expect(config.encryptKeyPair).toEqual(pair);
    expect(config.controlEncryptPublicKey).toBeUndefined();
    expect(h.logs.some((l) => l.includes("R11") || l.includes("registers this node's SAME static"))).toBe(true);
  });

  test("establishment WAS reached → no write at all: a dead established stream redials fully provisioned (RF#3)", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const config = baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: serverStatic.publicKey });
    const h = makeHarness({ config });
    const ws = new FakeWs();
    await h.negotiator.begin(ws);
    const kx = parseKxFrame(JSON.parse(ws.sends[0] as string));
    if (!kx) throw new Error("begin() sent no kx");
    const session = await createServerSession({ serverStatic, clientEphemeralPublicKey: kx.eph });
    h.negotiator.onBytesFrame(ws, session.sealFrame(JSON.stringify({ t: "ok" })));
    expect(h.negotiator.established()).toBe(true);

    // The stream later dies with a 4410 — from the plane, or from this side's
    // own ratchet-refuse; either way `reachedEstablished` gates the clear: the
    // byte-flip recovery (RF#3) redials FULLY PROVISIONED and must not be
    // downgraded into a register.
    h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.patches).toEqual([]);
    expect(config.controlEncryptPublicKey).toBe(serverStatic.publicKey); // byte-identical
  });

  test("our OWN refusal keeps the config byte-identical (ratchet desync, junk pin, wrong-kind frames)", async () => {
    // The sharpest gate: mode is handshake, established was never reached, and
    // the close code IS 4410 — `selfRefused` is the only thing standing between
    // this state and an unrequested pin drop.
    const s = await provisionedSocket();
    s.h.negotiator.onTextFrame(s.ws, JSON.stringify({ type: "heartbeat" })); // the negotiator itself refuses with 4410
    expect(s.ws.closes[0]?.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    s.h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED); // finish() feeds the close back
    expect(s.h.patches).toEqual([]);
    expect(s.config.controlEncryptPublicKey).toBeDefined();
  });

  test("register mode never clears: a refused register must not erase the pair it continues with", async () => {
    const ws = new FakeWs();
    const config = baseConfig();
    const h = makeHarness({ config });
    await h.negotiator.begin(ws); // register mode — the pair's own store lands HERE
    const before = h.patches.length;
    h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.patches).toHaveLength(before); // no clear patch added…
    expect(h.patches.some((p) => "controlEncryptPublicKey" in p)).toBe(false); // …and never one naming the pin
    expect(config.encryptKeyPair).toBeDefined(); // the pair survives to continue the registration
  });

  test("every non-4410 close keeps the config byte-identical", async () => {
    const a = await provisionedSocket();
    a.h.negotiator.onClosed(1006);
    expect(a.h.patches).toEqual([]);
    const b = await provisionedSocket();
    b.h.negotiator.onClosed(1012);
    expect(b.h.patches).toEqual([]);
  });

  test("idempotent: a second onClosed persists nothing further", async () => {
    const { h } = await provisionedSocket();
    h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED);
    h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(h.patches).toHaveLength(1);
  });

  test("a FAILED pin-drop is logged loudly, never swallowed (this file is the identity's half)", async () => {
    const serverStatic = await serverFixture();
    const pair = await generateLinkKeyPair();
    const config = baseConfig({ encryptKeyPair: pair, controlEncryptPublicKey: serverStatic.publicKey });
    const h = makeHarness({
      config,
      persist: async () => {
        throw new Error("disk full");
      },
    });
    const ws = new FakeWs();
    await h.negotiator.begin(ws);
    h.negotiator.onClosed(NODE_CLOSE_HANDSHAKE_REQUIRED);
    await new Promise((r) => setTimeout(r, 20)); // the rejection must surface, not hang or crash the run
    expect(h.logs.some((l) => l.includes("could not drop") && l.includes("disk full"))).toBe(true);
  });
});

describe("the legacy-mode classification and the wire helpers", () => {
  test("register-ok validation uses the protocol parser's exact shape", async () => {
    const s = await ensureSodium();
    const k = s.to_base64(s.crypto_kx_keypair().publicKey);
    expect(parseRegisterOkFrame({ t: "register-ok", controlEncryptPublicKey: k })).not.toBeNull();
  });

  test("binaryPayload is a Buffer VIEW of the ciphertext (the Elysia text-frame trap, ported)", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5]);
    const out = binaryPayload(src);
    expect(out).toBeInstanceOf(Buffer);
    expect(out.length).toBe(src.length);
    expect(Buffer.compare(out, Buffer.from(src))).toBe(0);
    // A view, not a copy: writing through the Buffer shows in the source.
    out[0] = 42;
    expect(src[0]).toBe(42);
  });
});

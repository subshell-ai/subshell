import { describe, expect, it } from "bun:test";
import {
  createClientSession,
  createClientSessionWithEphemeral,
  createServerSession,
  ensureSodium,
  generateLinkKeyPair,
  LINK_HEADER_BYTES,
  type LinkKeyPair,
  type LinkSession,
  parseKxFrame,
  parseLinkAck,
  parseLinkBinding,
  parseRegisterFrame,
  parseRegisterOkFrame,
  type Sodium,
} from "../node-link-crypto.js";

/**
 * A REAL key encoded by the module's own encoder — the exact spelling that
 * ships on the wire (libsodium's `to_base64` DEFAULT: URL-safe, no padding).
 * The hand-written padded-standard fixture this replaces is what hid the R5
 * bug: the old validators tested the shared padded `BASE64_RE`, which rejects
 * every key this module actually emits. Derived, never typed, so it cannot
 * drift from the encoder again.
 */
const { publicKey: sodiumB64 } = await generateLinkKeyPair();

/**
 * A pinned node static pair for the seal/open tests — this is the SERVER
 * static's stand-in (one DH, ephemeral×static: the kx derivation never sees a
 * node static, per the module header).
 */
async function makeServerStatic(): Promise<LinkKeyPair> {
  return generateLinkKeyPair();
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A secretstream consumer built OUTSIDE the module, keyed directly with a
 * known key — the instrument the KAT uses to ask "which key does this end
 * actually seal with", which a same-library round trip cannot answer.
 */
function openStreamWithKey(sodium: Sodium, key: Uint8Array, frame: Uint8Array): string | null {
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(frame.subarray(0, LINK_HEADER_BYTES), key);
  const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, frame.subarray(LINK_HEADER_BYTES), null);
  return result === false ? null : sodium.to_string(result.message);
}

/** The same, inverted: a producer keyed directly with a known key. */
function sealStreamWithKey(sodium: Sodium, key: Uint8Array, plaintext: string): Uint8Array {
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    sodium.from_string(plaintext),
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
  );
  return concatBytes([header, ct]);
}

async function makeInteroperatingPair(
  ephemeral: LinkKeyPair,
): Promise<{ client: LinkSession; server: LinkSession; serverStatic: LinkKeyPair }> {
  const serverStatic = await makeServerStatic();
  const { session: client } = await createClientSessionWithEphemeral({
    serverStaticPublicKey: serverStatic.publicKey,
    ephemeral,
  });
  const server = await createServerSession({
    serverStatic,
    clientEphemeralPublicKey: ephemeral.publicKey,
  });
  return { client, server, serverStatic };
}

describe("node-link-crypto", () => {
  it("ensureSodium is an idempotent ready gate exposing the base64 helpers Tasks 7/9 need", async () => {
    const a = await ensureSodium();
    const b = await ensureSodium();
    expect(a).toBe(b);
    expect(typeof a.from_base64).toBe("function");
    expect(typeof a.to_base64).toBe("function");
  });

  it("generateLinkKeyPair yields fresh 32-byte base64 x25519 pairs", async () => {
    const sodium = await ensureSodium();
    const pair = await generateLinkKeyPair();
    const again = await generateLinkKeyPair();
    expect(sodium.from_base64(pair.publicKey).length).toBe(32);
    expect(sodium.from_base64(pair.privateKey).length).toBe(32);
    expect(pair.publicKey).not.toBe(again.publicKey);
    expect(pair.privateKey).not.toBe(again.privateKey);
  });

  it("round-trips frames between a client and server session", async () => {
    await ensureSodium();
    const clientEph = await generateLinkKeyPair();
    const { client, server } = await makeInteroperatingPair(clientEph);
    const a = server.openFrame(client.sealFrame(JSON.stringify({ nodeId: "n", nodeKey: "k", protocolVersion: 14 })));
    expect(parseLinkBinding(JSON.parse(a!))).toEqual({ nodeId: "n", nodeKey: "k", protocolVersion: 14 });
    const b = client.openFrame(server.sealFrame(JSON.stringify({ t: "ok" })));
    expect(parseLinkAck(JSON.parse(b!))).toEqual({ t: "ok" });
    // later frames work too (the ratchet rekeys per message)
    expect(client.openFrame(server.sealFrame("second"))).toBe("second");
    expect(server.openFrame(client.sealFrame("second"))).toBe("second");
  });

  it("createClientSession (production path) is the deterministic twin with a fresh ephemeral", async () => {
    const sodium = await ensureSodium();
    const serverStatic = await generateLinkKeyPair();
    const { session: client, ephemeralPublicKey } = await createClientSession({
      serverStaticPublicKey: serverStatic.publicKey,
    });
    expect(sodium.from_base64(ephemeralPublicKey).length).toBe(32);
    const server = await createServerSession({ serverStatic, clientEphemeralPublicKey: ephemeralPublicKey });
    expect(server.openFrame(client.sealFrame("up"))).toBe("up");
    expect(client.openFrame(server.sealFrame("down"))).toBe("down");
    // the ephemeral really is per-connection fresh
    const second = await createClientSession({ serverStaticPublicKey: serverStatic.publicKey });
    expect(second.ephemeralPublicKey).not.toBe(ephemeralPublicKey);
  });

  it("the first sealed frame carries the 24-byte secretstream header", async () => {
    const sodium = await ensureSodium();
    const { client, server } = await makeInteroperatingPair(await generateLinkKeyPair());
    const msg = "first frame";
    const first = client.sealFrame(msg);
    const abytes = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
    expect(LINK_HEADER_BYTES).toBe(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    expect(first.length).toBe(LINK_HEADER_BYTES + abytes + sodium.from_string(msg).length);
    const second = client.sealFrame(msg);
    expect(second.length).toBe(abytes + sodium.from_string(msg).length);
    // …and the peer still opens both, in order, having consumed the header once
    expect(server.openFrame(first)).toBe(msg);
    expect(server.openFrame(second)).toBe(msg);
  });

  it("openFrame returns null — never throws — on tampered or unparseable ciphertext", async () => {
    await ensureSodium();
    const { client, server } = await makeInteroperatingPair(await generateLinkKeyPair());
    const other = await makeInteroperatingPair(await generateLinkKeyPair());
    const frame = client.sealFrame("payload");
    const flipped = frame.slice();
    flipped[flipped.length - 1] ^= 0x01;
    expect(server.openFrame(flipped)).toBeNull();
    // a frame from a different session is a tag failure for this one, not a key error
    expect(server.openFrame(other.client.sealFrame("payload").slice(LINK_HEADER_BYTES))).toBeNull();
    // structurally impossible inputs
    expect(server.openFrame(new Uint8Array(0))).toBeNull();
    expect(server.openFrame(new Uint8Array(7))).toBeNull();
    expect(server.openFrame(new Uint8Array(64).fill(0xab))).toBeNull();
  });

  it("pins kx known-answer derivation", async () => {
    const sodium = await ensureSodium();
    // --- source: the published vector ---
    // Transcribed verbatim from libsodium's own test suite: test/default/kx.c
    // (the deterministic final scenario: client pair from crypto_kx_seed_keypair
    // over seed bytes 0..31, server pair from the same seed after
    // sodium_increment — which is LITTLE-ENDIAN, so only seed[0] changes and
    // the server seed is [1,1,2,3,...,31]) and its published expected output
    // test/default/kx.exp:
    //   https://github.com/jedisct1/libsodium/blob/1.0.22/test/default/kx.c
    //   https://github.com/jedisct1/libsodium/blob/1.0.22/test/default/kx.exp
    // kx.exp does not print the server pair, so it is re-derived in-test from
    // the seed; its correctness is then PROVEN by all four published session
    // keys reproducing. All six transcribed constants below are published;
    // the schedule recomputation afterward is the brief's secondary pin, and
    // the module-wiring checks afterward are what THIS task is actually for.
    const PUBLISHED_EPHEMERAL_PK = "0e0216223f147143d32615a91189c288c1728cba3cc5f9f621b1026e03d83129";
    const PUBLISHED_EPHEMERAL_SK = "cb2f5160fc1f7e05a55ef49d340b48da2e5a78099d53393351cd579dd42503d6";
    const PUBLISHED_CLIENT_RX = "749519c68059bce69f7cfcc7b387a3de1a1e8237d110991323bf62870115731a";
    const PUBLISHED_CLIENT_TX = "62c8f4fa81800abd0577d99918d129b65deb789af8c8351f391feb0cbf238604";
    // kx.exp's server lines (the same two values by construction — server_rx
    // IS client_tx — transcribed separately because they are the published fact).
    const PUBLISHED_SERVER_RX = "62c8f4fa81800abd0577d99918d129b65deb789af8c8351f391feb0cbf238604";
    const PUBLISHED_SERVER_TX = "749519c68059bce69f7cfcc7b387a3de1a1e8237d110991323bf62870115731a";

    const clientSeed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const serverSeed = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : i)); // little-endian sodium_increment
    const eph = sodium.crypto_kx_seed_keypair(clientSeed);
    // pair derivation itself is deterministic and published:
    expect(sodium.to_hex(eph.publicKey)).toBe(PUBLISHED_EPHEMERAL_PK);
    expect(sodium.to_hex(eph.privateKey)).toBe(PUBLISHED_EPHEMERAL_SK);
    const srv = sodium.crypto_kx_seed_keypair(serverSeed);

    // --- the library's kx reproduces all four published session keys, and its
    // sharedRx/sharedTx naming is faithful to the C rx/tx arguments ---
    const clientKeys = sodium.crypto_kx_client_session_keys(eph.publicKey, eph.privateKey, srv.publicKey);
    expect(sodium.to_hex(clientKeys.sharedRx)).toBe(PUBLISHED_CLIENT_RX);
    expect(sodium.to_hex(clientKeys.sharedTx)).toBe(PUBLISHED_CLIENT_TX);
    const serverKeys = sodium.crypto_kx_server_session_keys(srv.publicKey, srv.privateKey, eph.publicKey);
    expect(sodium.to_hex(serverKeys.sharedRx)).toBe(PUBLISHED_SERVER_RX);
    expect(sodium.to_hex(serverKeys.sharedTx)).toBe(PUBLISHED_SERVER_TX);

    // --- the documented schedule, recomputed with primitives other than the
    // kx construction: BLAKE2b-512(dh || client_pk || server_pk), first half =
    // client receive, second half = client send (measured, not assumed). ---
    const dh = sodium.crypto_scalarmult(eph.privateKey, srv.publicKey);
    const hash = sodium.crypto_generichash(64, concatBytes([dh, eph.publicKey, srv.publicKey]), null);
    expect(sodium.to_hex(hash.slice(0, 32))).toBe(PUBLISHED_CLIENT_RX);
    expect(sodium.to_hex(hash.slice(32, 64))).toBe(PUBLISHED_CLIENT_TX);

    // --- and the module's sessions carry THAT wiring: seal = own sharedTx,
    // open = own sharedRx, verified through streams keyed directly with the
    // published bytes, in both directions. A session that sealed with the
    // wrong half would fail the FIRST check below, not the last. ---
    const { session: client } = await createClientSessionWithEphemeral({
      serverStaticPublicKey: sodium.to_base64(srv.publicKey),
      ephemeral: { publicKey: sodium.to_base64(eph.publicKey), privateKey: sodium.to_base64(eph.privateKey) },
    });
    const server = await createServerSession({
      serverStatic: { publicKey: sodium.to_base64(srv.publicKey), privateKey: sodium.to_base64(srv.privateKey) },
      clientEphemeralPublicKey: sodium.to_base64(eph.publicKey),
    });
    const clientTx = sodium.from_hex(PUBLISHED_CLIENT_TX);
    const clientRx = sodium.from_hex(PUBLISHED_CLIENT_RX);
    // client seals with its published send key …
    expect(openStreamWithKey(sodium, clientTx, client.sealFrame("kx vector"))).toBe("kx vector");
    // … server seals with its published send key (kx.exp's server_tx) …
    expect(openStreamWithKey(sodium, sodium.from_hex(PUBLISHED_SERVER_TX), server.sealFrame("ack"))).toBe("ack");
    // … client opens with its published receive key …
    expect(client.openFrame(sealStreamWithKey(sodium, clientRx, "down-1"))).toBe("down-1");
    // … server opens with its published receive key (kx.exp's server_rx).
    expect(server.openFrame(sealStreamWithKey(sodium, sodium.from_hex(PUBLISHED_SERVER_RX), "up-1"))).toBe("up-1");
  });

  describe("validators", () => {
    it("parseKxFrame accepts the two legal shapes and nothing else", async () => {
      await ensureSodium();
      expect(parseKxFrame({ t: "kx", eph: sodiumB64 })).toEqual({ t: "kx", eph: sodiumB64 });
      expect(parseKxFrame({ t: "kx", eph: sodiumB64, pub: sodiumB64 })).toEqual({
        t: "kx",
        eph: sodiumB64,
        pub: sodiumB64,
      });
      for (const junk of [
        null,
        undefined,
        "",
        {},
        { t: "kx" },
        { t: "kx", eph: 123 },
        { t: "kx", eph: "" },
        { t: "kx", eph: "!!!" },
        { t: "kx", eph: sodiumB64, pub: 5 },
        { t: "kx", eph: sodiumB64, pub: "" },
        { t: "register", eph: sodiumB64 },
        [],
      ]) {
        expect(parseKxFrame(junk)).toBeNull();
      }
    });

    it("parseRegisterFrame requires a well-formed pub", () => {
      expect(parseRegisterFrame({ t: "register", pub: sodiumB64 })).toEqual({ t: "register", pub: sodiumB64 });
      for (const junk of [
        null,
        "",
        {},
        { t: "register" },
        { t: "register", pub: "" },
        { t: "register", pub: 7 },
        { t: "kx", pub: sodiumB64 },
      ]) {
        expect(parseRegisterFrame(junk)).toBeNull();
      }
    });

    it("parseRegisterOkFrame requires a well-formed controlEncryptPublicKey", () => {
      expect(parseRegisterOkFrame({ t: "register-ok", controlEncryptPublicKey: sodiumB64 })).toEqual({
        t: "register-ok",
        controlEncryptPublicKey: sodiumB64,
      });
      for (const junk of [
        null,
        {},
        { t: "register-ok" },
        { t: "register-ok", controlEncryptPublicKey: "" },
        { t: "register-ok", controlEncryptPublicKey: "???" },
        { t: "ok" },
      ]) {
        expect(parseRegisterOkFrame(junk)).toBeNull();
      }
    });

    it("a real generated key must validate — this is the exact spelling on the wire", async () => {
      // A hand-written padded fixture let the old bug through: the validators
      // once tested the shared padded-standard `BASE64_RE`, which rejects
      // EVERY key `to_base64` emits. Only the encoder's own output can pin
      // the alphabet, so this test derives live keys rather than typing one.
      const pair = await generateLinkKeyPair();
      expect(pair.publicKey).toMatch(/^[A-Za-z0-9_-]+$/); // libsodium's default: URL-safe, no padding
      expect(parseKxFrame({ t: "kx", eph: pair.publicKey, pub: pair.publicKey })).not.toBeNull();
      expect(parseRegisterFrame({ t: "register", pub: pair.publicKey })).not.toBeNull();
      expect(parseRegisterOkFrame({ t: "register-ok", controlEncryptPublicKey: pair.publicKey })).not.toBeNull();
      // the production path's eph field goes through the same check
      const serverStatic = await generateLinkKeyPair();
      const { ephemeralPublicKey } = await createClientSession({ serverStaticPublicKey: serverStatic.publicKey });
      expect(parseKxFrame({ t: "kx", eph: ephemeralPublicKey })).not.toBeNull();
    });

    it("parseLinkBinding requires the three binding fields", () => {
      expect(parseLinkBinding({ nodeId: "n1", nodeKey: "nsk", protocolVersion: 14 })).toEqual({
        nodeId: "n1",
        nodeKey: "nsk",
        protocolVersion: 14,
      });
      for (const junk of [
        null,
        "",
        {},
        { nodeId: "n1" },
        { nodeId: "n1", nodeKey: "nsk" },
        { nodeId: 1, nodeKey: "nsk", protocolVersion: 14 },
        { nodeId: "n1", nodeKey: "nsk", protocolVersion: "14" },
        { nodeId: "n1", nodeKey: "nsk", protocolVersion: 14.5 },
        { nodeId: "n1", nodeKey: "nsk", protocolVersion: Number.NaN },
      ]) {
        expect(parseLinkBinding(junk)).toBeNull();
      }
    });

    it("parseLinkAck accepts only {t: ok}", () => {
      expect(parseLinkAck({ t: "ok" })).toEqual({ t: "ok" });
      for (const junk of [null, "", {}, { t: "ok?" }, { ok: true }, { t: "kx" }]) {
        expect(parseLinkAck(junk)).toBeNull();
      }
    });
  });
});

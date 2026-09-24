import { describe, expect, it } from "bun:test";
import { MIN_NODE_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import {
  createClientSession,
  ensureSodium,
  generateLinkKeyPair,
  type LinkKeyPair,
  type LinkSession,
} from "@internal/subshell-protocol/node-link-crypto";
import {
  beginLinkUpgrade,
  HANDSHAKE_TIMEOUT_MS,
  handleLinkFrame,
  handshakeIncomplete,
  type LinkFrame,
  type LinkOutcome,
  type LinkSessionDeps,
  type LinkWsData,
} from "../link-session.js";

/**
 * The handshake machine driven with REAL crypto: a genuine `createClientSession`
 * mints the `kx` ephemeral and encrypts the binding, so every accept path here
 * is also a proof the two ends derive the same keys. Only the I/O seams
 * (keypair load, row write, api-key verify) are fakes.
 */

const NODE_ID = "node-1";
const API_KEY_ID = "ak-1";
/** The live node key the binding carries; the fake verifier maps it to THIS row. */
const LIVE_NODE_KEY = "subshell_live_node_key";
/** A real node key from ANOTHER row — proves the re-prove is not "any valid key". */
const FOREIGN_NODE_KEY = "subshell_foreign_node_key";

/** The 4410 constant as the test names it; imported by number so a silent
 * constant change in the protocol package fails loudly here. */
const CLOSE_4410 = 4410;

interface Harness {
  deps: LinkSessionDeps;
  calls: {
    load: number;
    verify: number;
    setPub: { id: string; key: string }[];
  };
  serverStatic: LinkKeyPair;
  nodeStatic: LinkKeyPair;
  client: { session: LinkSession; ephemeralPublicKey: string };
}

async function makeHarness(): Promise<Harness> {
  const serverStatic = await generateLinkKeyPair();
  const nodeStatic = await generateLinkKeyPair();
  const client = await createClientSession({ serverStaticPublicKey: serverStatic.publicKey });
  const calls = { load: 0, verify: 0, setPub: [] as { id: string; key: string }[] };
  const deps: LinkSessionDeps = {
    loadNodeEncryptionKeys: async () => {
      calls.load += 1;
      return serverStatic;
    },
    nodeEncryptionPublicKey: async () => serverStatic.publicKey,
    setEncryptPublicKey: async (id, key) => {
      calls.setPub.push({ id, key });
    },
    verifyApiKey: async (rawKey) => {
      calls.verify += 1;
      // Mirrors NodeWsDeps.verifyApiKey's real return shape: the api-key ROW
      // (its id, not the node's) plus the `{kind,nodeId}` metadata.
      if (rawKey === LIVE_NODE_KEY) {
        return { id: API_KEY_ID, metadata: { kind: "node", nodeId: NODE_ID } };
      }
      if (rawKey === FOREIGN_NODE_KEY) {
        return { id: "ak-OTHER", metadata: { kind: "node", nodeId: "node-OTHER" } };
      }
      return null;
    },
  };
  return { deps, calls, serverStatic, nodeStatic, client };
}

function handshakeData(pin: string | null = null): LinkWsData {
  return {
    nodeId: NODE_ID,
    apiKeyId: API_KEY_ID,
    linkMode: "handshake",
    linkEncryptPublicKey: pin,
  };
}

function legacyData(): LinkWsData {
  return {
    nodeId: NODE_ID,
    apiKeyId: API_KEY_ID,
    linkMode: "legacy",
    linkEncryptPublicKey: null,
  };
}

function kxText(h: Harness, over?: Record<string, unknown>): LinkFrame {
  const body: Record<string, unknown> = {
    t: "kx",
    eph: h.client.ephemeralPublicKey,
    pub: h.nodeStatic.publicKey,
    ...over,
  };
  // `pub: undefined` must DROP the key, not serialize `null`.
  if (body.pub === undefined) delete body.pub;
  return { text: JSON.stringify(body) };
}

function bindingBytes(
  h: Harness,
  over?: Partial<{ nodeId: string; nodeKey: string; protocolVersion: number }>,
): LinkFrame {
  const payload = JSON.stringify({
    nodeId: NODE_ID,
    nodeKey: LIVE_NODE_KEY,
    protocolVersion: NODE_PROTOCOL_VERSION,
    ...over,
  });
  return { bytes: h.client.session.sealFrame(payload) };
}

function readyJson(over?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "ready",
    agentVersion: MIN_NODE_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    dataDir: "/home/u/.config/subshell",
    capabilities: ["launch"],
    ...over,
  });
}

/** Untyped-on-purpose: the caller that feeds `handleLinkFrame` widens it. */
function readyEventText(over?: Record<string, unknown>) {
  return { text: readyJson(over) };
}

/** Drive kx + binding; returns the established outcome and the stashed data. */
async function driveHandshake(h: Harness, data: LinkWsData) {
  const kx = await handleLinkFrame(h.deps, { data }, kxText(h));
  expect(kx).toEqual({ consumed: true });
  const binding = await handleLinkFrame(h.deps, { data }, bindingBytes(h));
  return { kx, binding, data };
}

function expectClose(outcome: LinkOutcome, reasonIncludes?: string): void {
  expect("close" in outcome).toBe(true);
  if (!("close" in outcome)) return;
  expect(outcome.close.code).toBe(CLOSE_4410);
  if (reasonIncludes) expect(outcome.close.reason).toContain(reasonIncludes);
}

describe("beginLinkUpgrade", () => {
  it("classifies a pinned row as handshake", () => {
    expect(beginLinkUpgrade({ encryptPublicKey: "AAA" })).toEqual({ mode: "handshake" });
  });
  it("classifies a pin-less row as legacy", () => {
    expect(beginLinkUpgrade({ encryptPublicKey: null })).toEqual({ mode: "legacy" });
  });
});

describe("handshake mode — happy path", () => {
  it("kx is consumed with NO reply at all (R6), then the binding establishes with an ok the client decrypts", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);

    const kx = await handleLinkFrame(h.deps, { data }, kxText(h));
    // R6: the machine emits NOTHING for kx — no bytes, no text.
    expect(kx).toEqual({ consumed: true });
    expect("sendBytes" in kx).toBe(false);
    expect("sendText" in kx).toBe(false);
    expect(data.linkPhase).toBe("awaiting-binding");
    expect(handshakeIncomplete(data)).toBe(true);

    const binding = await handleLinkFrame(h.deps, { data }, bindingBytes(h));
    expect("consumed" in binding && binding.consumed).toBe(true);
    expect("established" in binding && "sendBytes" in binding).toBe(true);
    if (!("established" in binding) || !("sendBytes" in binding)) return;

    // The crypto proof: the server's first push decrypts ON THE CLIENT SIDE.
    const opened = h.client.session.openFrame(binding.sendBytes);
    expect(opened).toBe('{"t":"ok"}');
    expect(data.linkPhase).toBe("established");
    expect(handshakeIncomplete(data)).toBe(false);

    // Established traffic: a sealed ready forwards as its plaintext.
    const readyJson = JSON.stringify({ type: "heartbeat", ts: "2026-09-24T00:00:00Z" });
    const fwd = await handleLinkFrame(h.deps, { data }, { bytes: h.client.session.sealFrame(readyJson) });
    expect(fwd).toEqual({ forwarded: readyJson });
  });

  it("re-proves the nodeKey through the SAME comparison the upgrade ran (re-runs verifyApiKey)", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await driveHandshake(h, data);
    // kx does not touch the verifier; only the binding re-prove does.
    expect(h.calls.verify).toBe(1);
    expect(h.calls.load).toBe(1);
  });
});

describe("handshake mode — every refusal is 4410", () => {
  it("rejects a kx eph that does not decode to 32 bytes", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const short = sodium.to_base64(new Uint8Array(31));
    const outcome = await handleLinkFrame(
      h.deps,
      { data: handshakeData(h.nodeStatic.publicKey) },
      kxText(h, { eph: short }),
    );
    expectClose(outcome, "eph");
  });

  it("rejects a kx pub that does not decode to 32 bytes", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const short = sodium.to_base64(new Uint8Array(31));
    const outcome = await handleLinkFrame(
      h.deps,
      { data: handshakeData(h.nodeStatic.publicKey) },
      kxText(h, { pub: short }),
    );
    expectClose(outcome, "pub");
  });

  it("rejects a kx with NO pub field (the claim is mandatory on this socket)", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(
      h.deps,
      { data: handshakeData(h.nodeStatic.publicKey) },
      kxText(h, { pub: undefined }),
    );
    expectClose(outcome);
  });

  it("closes a pub mismatch and NEVER reaches derivation (createServerSession is uncallable without the load)", async () => {
    const h = await makeHarness();
    const other = await generateLinkKeyPair();
    const outcome = await handleLinkFrame(
      h.deps,
      { data: handshakeData(h.nodeStatic.publicKey) },
      kxText(h, { pub: other.publicKey }),
    );
    expectClose(outcome, "pub mismatch");
    // The spy that matters: derivation loads the server static as its FIRST
    // step, so zero loads proves createServerSession was never reached.
    expect(h.calls.load).toBe(0);
  });

  it("closes when the row's pin is not 32 decodable bytes (pin malformed — mismatch without derivation)", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const badPin = sodium.to_base64(new Uint8Array(31));
    const outcome = await handleLinkFrame(h.deps, { data: handshakeData(badPin) }, kxText(h));
    expectClose(outcome);
    expect(h.calls.load).toBe(0);
  });

  it("closes a plaintext ready as the FIRST frame on a handshake row (the downgrade attempt)", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(h.deps, { data: handshakeData(h.nodeStatic.publicKey) }, readyEventText());
    expectClose(outcome, "handshake required");
    expect(h.calls.load).toBe(0);
  });

  it("closes a pre-parsed plaintext object on a handshake row (Elysia's JSON-parsed form)", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(
      h.deps,
      { data: handshakeData(h.nodeStatic.publicKey) },
      { text: { type: "ready", agentVersion: MIN_NODE_VERSION, protocolVersion: NODE_PROTOCOL_VERSION } },
    );
    expectClose(outcome, "handshake required");
  });

  it("closes ciphertext arriving before kx", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const random = sodium.randombytes_buf(64);
    const outcome = await handleLinkFrame(h.deps, { data: handshakeData(h.nodeStatic.publicKey) }, { bytes: random });
    expectClose(outcome, "unexpected");
  });

  it("closes a plaintext frame while awaiting the binding", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, readyEventText());
    expectClose(outcome, "unexpected");
  });

  it("closes undecryptable first bytes in awaiting-binding", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, { bytes: sodium.randombytes_buf(64) });
    expectClose(outcome, "binding undecryptable");
  });

  it("closes first bytes too short to carry a secretstream header", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, { bytes: new Uint8Array(8) });
    expectClose(outcome, "binding undecryptable");
  });

  it("closes a binding that decrypts to non-JSON / the wrong shape", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, { bytes: h.client.session.sealFrame("not json at all") });
    expectClose(outcome, "binding malformed");
  });

  it("closes a binding whose nodeId is not the authenticated row", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, bindingBytes(h, { nodeId: "node-IMPOSTOR" }));
    expectClose(outcome, "nodeId");
  });

  it("closes a binding whose nodeKey is dead (verifyApiKey returns null)", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, bindingBytes(h, { nodeKey: "subshell_revoked_key" }));
    expectClose(outcome, "nodeKey");
  });

  it("closes a binding whose nodeKey is a DIFFERENT row's valid key (the re-prove is identity, not validity)", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(h.deps, { data }, bindingBytes(h, { nodeKey: FOREIGN_NODE_KEY }));
    expectClose(outcome, "nodeKey");
  });

  it("closes a binding whose protocolVersion is not this server's", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    const outcome = await handleLinkFrame(
      h.deps,
      { data },
      bindingBytes(h, { protocolVersion: NODE_PROTOCOL_VERSION - 1 }),
    );
    expectClose(outcome, "protocol");
  });

  it("closes any plaintext frame once established", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await driveHandshake(h, data);
    const outcome = await handleLinkFrame(h.deps, { data }, readyEventText());
    expectClose(outcome, "unexpected");
  });

  it("closes broken ciphertext once established (the stream never resyncs)", async () => {
    const h = await makeHarness();
    const data = handshakeData(h.nodeStatic.publicKey);
    await driveHandshake(h, data);
    const sodium = await ensureSodium();
    const outcome = await handleLinkFrame(h.deps, { data }, { bytes: sodium.randombytes_buf(64) });
    expectClose(outcome);
  });
});

describe("legacy mode", () => {
  it("register writes the canonical pin and answers register-ok, then closes NORMALLY (R7, not 4410)", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const outcome = await handleLinkFrame(
      h.deps,
      { data: legacyData() },
      { text: JSON.stringify({ t: "register", pub: h.nodeStatic.publicKey }) },
    );
    expect("close" in outcome).toBe(false);
    expect("sendText" in outcome && "thenClose" in outcome).toBe(true);
    if (!("sendText" in outcome) || !("thenClose" in outcome)) return;
    expect(outcome.thenClose).toBe(true);
    const reply = JSON.parse(outcome.sendText) as { t: string; controlEncryptPublicKey: string };
    expect(reply.t).toBe("register-ok");
    expect(reply.controlEncryptPublicKey).toBe(h.serverStatic.publicKey);
    // Stored through the SAME canonical re-encode as enroll (route:223): the
    // bytes that decoded, re-emitted — not the wire spelling.
    expect(h.calls.setPub).toEqual([
      { id: NODE_ID, key: sodium.to_base64(sodium.from_base64(h.nodeStatic.publicKey)) },
    ]);
  });

  it("rejects a padded URL-safe spelling of a valid key — only the canonical alphabet the machine stores decodes", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    // 32 bytes through the PADDING url-safe variant: same key bytes, one
    // trailing "=". The shape gate lets it through; the decode does not.
    const padded = sodium.to_base64(sodium.from_base64(h.nodeStatic.publicKey), sodium.base64_variants.URLSAFE);
    expect(padded.endsWith("=")).toBe(true);
    const outcome = await handleLinkFrame(
      h.deps,
      { data: legacyData() },
      { text: JSON.stringify({ t: "register", pub: padded }) },
    );
    expectClose(outcome, "register");
    expect(h.calls.setPub).toEqual([]);
  });

  it("rejects a register pub that does not decode to 32 bytes, and stores nothing", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const short = sodium.to_base64(new Uint8Array(31));
    const outcome = await handleLinkFrame(
      h.deps,
      { data: legacyData() },
      { text: JSON.stringify({ t: "register", pub: short }) },
    );
    expectClose(outcome, "register");
    expect(h.calls.setPub).toEqual([]);
  });

  it("rejects a register whose pub is not base64-shaped at all", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(
      h.deps,
      { data: legacyData() },
      { text: JSON.stringify({ t: "register", pub: "not base64!!" }) },
    );
    expect("close" in outcome).toBe(true);
    expect(h.calls.setPub).toEqual([]);
  });

  it("holds a plain-plaintext ready that WOULD pass both gates — the R3 encryption-required signal", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, readyEventText());
    expect(outcome).toEqual({ holdEncryptionRequired: true });
  });

  it("applies R3 to the Elysia pre-parsed object form too", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(
      h.deps,
      { data: legacyData() },
      {
        text: {
          type: "ready",
          agentVersion: MIN_NODE_VERSION,
          protocolVersion: NODE_PROTOCOL_VERSION,
          os: "linux",
          arch: "x64",
          hostname: "box",
          dataDir: "/d",
          capabilities: [],
        },
      },
    );
    expect(outcome).toEqual({ holdEncryptionRequired: true });
  });

  it("forwards a below-floor ready unchanged (the existing hold path owns it)", async () => {
    const h = await makeHarness();
    const frame = readyEventText({ agentVersion: "0.0.1" });
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, frame);
    expect(outcome).toEqual({ forwarded: frame.text });
  });

  it("forwards a protocol-mismatch ready unchanged", async () => {
    const h = await makeHarness();
    const frame = readyEventText({ protocolVersion: NODE_PROTOCOL_VERSION - 1 });
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, frame);
    expect(outcome).toEqual({ forwarded: frame.text });
  });

  it("forwards ordinary legacy traffic (heartbeat) to the existing gates", async () => {
    const h = await makeHarness();
    const frame: LinkFrame = { text: JSON.stringify({ type: "heartbeat", ts: "2026-09-24T00:00:00Z" }) };
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, frame);
    expect(outcome).toEqual({ forwarded: frame.text });
  });

  it("forwards binary frames on a legacy row as-is (the existing unrecognized-drop path)", async () => {
    const h = await makeHarness();
    const sodium = await ensureSodium();
    const bytes = sodium.randombytes_buf(32);
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, { bytes });
    expect("forwarded" in outcome).toBe(true);
    if ("forwarded" in outcome) expect(outcome.forwarded).toBe(bytes);
  });

  it("does NOT hold a register-ok or any non-ready frame under R3", async () => {
    const h = await makeHarness();
    const frame: LinkFrame = { text: JSON.stringify({ type: "inventory", ts: "t", harnesses: [] }) };
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, frame);
    expect(outcome).toEqual({ forwarded: frame.text });
  });

  // R10 (spec 2026-09-24 follow-up): key rotation CLEARS the row's pin
  // (rotate-node-key.route.ts step 2), and the agent's config keeps both link
  // fields — so its redial arrives in handshake mode, on a row the machine
  // now classifies legacy. Before this, the `kx` was forwarded as garbage and
  // the binding dropped as garbage: no refusal, no deadline on either end,
  // an open socket that never establishes and never registers. The refusal
  // names the remedy: re-pair via register.
  it("refuses a real kx CLAIM on a legacy row, 4410 naming register (R10)", async () => {
    const h = await makeHarness();
    const outcome = await handleLinkFrame(h.deps, { data: legacyData() }, kxText(h));
    expectClose(outcome, "re-pair via register");
    // A pure shape decision: it lands BEFORE any derivation work, the same
    // order the handshake path keeps for its own pub-mismatch refusal.
    expect(h.calls.load).toBe(0);
    expect(h.calls.verify).toBe(0);
    expect(h.calls.setPub).toEqual([]);
  });

  it("keeps a kx that fails the shape gate forwarded-unrecognized — refusal is for real claims only", async () => {
    const h = await makeHarness();
    // "Real claim" is parseKxFrame's SHAPES decision (the same gate the
    // handshake path runs), not a 32-byte decode: the negotiator's claim
    // always carries eph AND pub, and anything the gate rejects — pub absent,
    // eph not base64-shaped at all — is someone who typed `"t":"kx"`, exactly
    // the junk the forwarded path always dropped.
    // Untyped on purpose (the file's convention): the union's `.text` accessor
    // belongs to these calls, not to the widened `LinkFrame` annotation.
    const noPub = { text: JSON.stringify({ t: "kx", eph: h.client.ephemeralPublicKey }) };
    expect(await handleLinkFrame(h.deps, { data: legacyData() }, noPub)).toEqual({ forwarded: noPub.text });
    const junkEph = {
      text: JSON.stringify({ t: "kx", eph: "not base64!!", pub: h.nodeStatic.publicKey }),
    };
    expect(await handleLinkFrame(h.deps, { data: legacyData() }, junkEph)).toEqual({ forwarded: junkEph.text });
    // The 31-byte case sits INSIDE the gate (base64-shaped), so it is a claim
    // by shape and refused — pinning where the boundary actually is.
    const sodium = await ensureSodium();
    const shortEph: LinkFrame = {
      text: JSON.stringify({ t: "kx", eph: sodium.to_base64(new Uint8Array(31)), pub: h.nodeStatic.publicKey }),
    };
    expectClose(await handleLinkFrame(h.deps, { data: legacyData() }, shortEph), "re-pair via register");
    // And Elysia's PRE-PARSED object form is the same decision, not a bypass.
    const preParsed: LinkFrame = { text: { t: "kx", eph: h.client.ephemeralPublicKey, pub: h.nodeStatic.publicKey } };
    expectClose(await handleLinkFrame(h.deps, { data: legacyData() }, preParsed), "re-pair via register");
  });

  it("the R10 sequence end-to-end server-side: claim → 4410, and the redial's register still pairs", async () => {
    // The self-heal's plane half, in wire order. Connect 1: the stale-identity
    // agent handshakes, gets the named refusal. Connect 2 (the redial, fresh
    // socket on the still-pin-less row): a register claim — it was never
    // poisoned by the refusal — pins, answers register-ok, closes normally
    // (R7), and connect 3 will classify handshake. The agent-side 4410
    // handling is pinned in apps/node/agent/src/__tests__/daemon.test.ts
    // ("(b) a 4410 handshake refusal relays the plane's reason and
    // reconnects — never terminal"); NOT duplicated here.
    const h = await makeHarness();
    const first = await handleLinkFrame(h.deps, { data: legacyData() }, kxText(h));
    expectClose(first, "re-pair via register");

    const redial = await handleLinkFrame(
      h.deps,
      { data: legacyData() },
      { text: JSON.stringify({ t: "register", pub: h.nodeStatic.publicKey }) },
    );
    expect("sendText" in redial && "thenClose" in redial).toBe(true);
    if (!("sendText" in redial) || !("thenClose" in redial)) return;
    const ok = JSON.parse(redial.sendText) as { t: string; controlEncryptPublicKey: string };
    expect(ok.t).toBe("register-ok");
    expect(ok.controlEncryptPublicKey).toBe(h.serverStatic.publicKey);
    expect(h.calls.setPub).toHaveLength(1);
  });
});

describe("handshake timeout budget", () => {
  it("exports a positive constant (Task 8 arms the timer)", () => {
    expect(typeof HANDSHAKE_TIMEOUT_MS).toBe("number");
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("handshakeIncomplete is false for a legacy socket and true for any unfinished handshake", async () => {
    const h = await makeHarness();
    expect(handshakeIncomplete(legacyData())).toBe(false);
    const data = handshakeData(h.nodeStatic.publicKey);
    expect(handshakeIncomplete(data)).toBe(true);
    await handleLinkFrame(h.deps, { data }, kxText(h));
    expect(handshakeIncomplete(data)).toBe(true);
    await handleLinkFrame(h.deps, { data }, bindingBytes(h));
    expect(handshakeIncomplete(data)).toBe(false);
  });
});

describe("invariant violations throw (never wire input)", () => {
  async function rejects(run: () => Promise<unknown>): Promise<void> {
    let threw = false;
    try {
      await run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  }

  it("throws when the socket was never classified", async () => {
    const h = await makeHarness();
    await rejects(() => handleLinkFrame(h.deps, { data: {} }, { text: "{}" }));
  });

  it("throws when the socket has no stashed nodeId", async () => {
    const h = await makeHarness();
    await rejects(() => handleLinkFrame(h.deps, { data: { linkMode: "legacy" } }, { text: "{}" }));
  });
});

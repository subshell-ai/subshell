import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSocketPath } from "@internal/pane-runtime";
import {
  base64UrlNoPad,
  newNonce,
  parseNodeSshAgentIdentities,
  parseRelayFrame,
  type RelayFrame,
  SSH_RELAY_LIFETIME_MS,
  type SshRelayOpenCommand,
} from "@internal/subshell-protocol";
import { exportJWK, generateKeyPair } from "jose";
import type { CommandContext } from "../../../../../node/agent/src/commands/context.js";
import { execSshAgentIdentities } from "../../../../../node/agent/src/commands/ssh-identity.js";
import { openARelaySession, openBRelaySession } from "../../../../../node/agent/src/commands/ssh-relay.js";
import { OPENSSH_10X_SCHEME } from "../../../../../node/agent/src/relay-agent-scheme.js";
import { writeSshEnabled } from "../../../../../node/agent/src/ssh-enabled.js";
import {
  buildSignRequestTenX,
  decodeA2B,
  decodeB2A,
  fp,
  framed,
  KEY_IN,
  KEY_OUT,
  openB2A,
  openStack,
  PANE_ID,
  parseAnswer,
  ROSTER,
  type Stack,
  sealA2B,
  sealB2A,
  sleep,
  sshStr,
  startStubAgent,
  waitUntil,
} from "./helpers/ssh-relay-stack.js";

/**
 * The M2 relay integration matrix (spec 2026-10-08, Task 9): the whole stack
 * at once. Two REAL machine identities (`loadOrCreateIdentity` in temp data
 * dirs), the REAL B proxy socket, the REAL A responder over a stub agent, and
 * the REAL plane broker, wired through a fake plane that is blind by
 * construction: it holds no private key, imports no opener, and touches only
 * JSON text ({type, ref, seq, direction, blob}) - the envelope is base64
 * ciphertext to it, as it is to the shipped broker.
 *
 * What each case asserts is observable bytes and side effects: the stub
 * agent's received list (what A's agent was actually asked), the pane
 * socket's received frames (what the pane's ssh actually got), the plane's
 * wire capture, and the serialized audit rows. Case 6 (replay inertness),
 * case 3 (wrong origin) and case 4 (scope-before-forward) are the crown
 * jewels: a replayed envelope must be inert, a foreign signature must not
 * reach the key home, and an ungranted blob must never be put in front of
 * A's agent, roster answer first or not.
 *
 * Matrix case 10 (the `ssh_agent_identities` roster command accepted with no
 * grant) shipped with Task 11, which built the command; it is the one case
 * that runs WITHOUT the stack, because the roster read consults nothing but
 * A's live agent and A's own gate mirror.
 */

/** An ES256 pair pinned by nobody: signatures from it are forgeries. */
const evilReady: Promise<{ privateJwk: string; publicJwk: string }> = generateKeyPair("ES256", {
  extractable: true,
}).then(async ({ publicKey, privateKey }) => ({
  publicJwk: JSON.stringify(await exportJWK(publicKey)),
  privateJwk: JSON.stringify(await exportJWK(privateKey)),
}));

/** The b64-of-UTF8 spelling the open command carries the peer encryption key in. */
function b64Jwk(jwkJson: string): string {
  return Buffer.from(jwkJson, "utf8").toString("base64");
}

/** The pane's ssh end: connect, collect framed replies, observe death. */
function paneAt(socketPath: string): {
  conn: Socket;
  closed: () => boolean;
  payloads: () => Buffer[];
  destroy(): void;
} {
  const conn = createConnection({ path: socketPath });
  const chunks: Buffer[] = [];
  let closed = false;
  conn.on("data", (d) => chunks.push(Buffer.from(d)));
  conn.on("close", () => {
    closed = true;
  });
  conn.on("error", () => {
    /* failures are read through the close/data events, never thrown */
  });
  return {
    conn,
    closed: () => closed,
    payloads: (): Buffer[] => {
      const buf = Buffer.concat(chunks);
      const out: Buffer[] = [];
      let off = 0;
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off);
        if (off + 4 + len > buf.length) break;
        out.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
      return out;
    },
    destroy: () => conn.destroy(),
  };
}

/** The frames the plane RECEIVED (node-to-plane legs), decoded, in order. */
function ingress(s: Stack): RelayFrame[] {
  return s.wire.filter((w) => !w.outbound).map((w) => JSON.parse(w.raw) as RelayFrame);
}

/** A2B envelopes A actually PRODUCED (the plane saw them leave A's socket). */
function producedByA(s: Stack): number {
  return s.wire.filter((w) => !w.outbound && w.nodeId === "a-node").length;
}

/** Change the first base64 character: same length, valid alphabet, broken first byte. */
function garbleBlob(blob: string): string {
  const replacement = blob[0] === "A" ? "B" : "A";
  return replacement + blob.slice(1);
}

/* ------------------------------------------------------------------ */
/* 1. the happy path: a granted sign round trips sealed                */
/* ------------------------------------------------------------------ */

test("1. a granted SIGN_REQUEST from the pane reaches A's agent and the signature comes back sealed: B opens it with A's pinned encryption key", async () => {
  const s = await openStack();
  try {
    // The broker's byte-check (acceptance (e)) already ran inside openRelay:
    // the returned path IS the proxy's real bound path, equal to the plane's
    // own derivation from B's dataDir and the command's pane.
    expect(s.result.socketPath).toBe(buildAgentSocketPath(s.bDir, PANE_ID));
    const p = paneAt(s.result.socketPath);
    const request = buildSignRequestTenX(KEY_IN, { algorithms: "ssh-ed25519" });
    p.conn.write(framed(request));
    await waitUntil(() => p.payloads().length === 1, "the SIGN_RESPONSE on the pane socket");
    expect([...p.payloads()[0]]).toEqual([14, 0, 0, 0, 3, ...Buffer.from("SIG")]); // measured 10.x bytes
    expect(s.forwarded()).toEqual([request]); // A's agent saw EXACTLY the scoped request, byte-identical

    const inF = ingress(s);
    expect(inF.length).toBe(2); // one B2A, one A2B; nothing else crossed
    expect(parseRelayFrame(JSON.stringify(inF[0]))).not.toBeNull();
    expect(inF[0].ref).toBe(s.result.ref);
    expect(inF[0].direction).toBe("B2A");
    expect(inF[1].direction).toBe("A2B");

    // Decode the pair independently, the way each endpoint's checklist does.
    const asA = await decodeB2A(s, inF[0]);
    expect(asA.agentBytes).toEqual(request);
    expect(asA.nB).toMatch(/^[A-Za-z0-9_-]{22}$/); // B minted its endpoint nonce
    expect(asA.nA).toBeUndefined(); // B spoke first; A's nonce is not in a request yet
    const asB = await decodeA2B(s, inF[1]); // opens with B's own pinned encryption half
    expect(asB.agentBytes).toEqual(p.payloads()[0]); // what B can OPEN is what B's pane receives
    expect(asB.nA).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(asB.nB).toBe(asA.nB); // the SAME session nonces ride both directions
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 2. the method allow-list end to end                                 */
/* ------------------------------------------------------------------ */

test("2. a non-allow-listed agent method (EXTENSION) is refused at A and never forwarded, over the real socket", async () => {
  const s = await openStack();
  try {
    const p = paneAt(s.result.socketPath);
    p.conn.write(framed(Buffer.concat([Buffer.from([27]), sshStr("ssh-agent-extension-op"), Buffer.from([1])])));
    await waitUntil(() => p.payloads().length === 1, "the clean refusal");
    expect([...p.payloads()[0]]).toEqual([5]); // SSH2_AGENT_FAILURE, never a hang
    await sleep(30);
    expect(s.forwarded()).toEqual([]); // A's agent was never asked
    expect(producedByA(s)).toBe(1); // the [5] is A's own synthesized refusal: one A2B left A's socket
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 3. wrong origin: an unpinned machine key must not reach the key home */
/* ------------------------------------------------------------------ */

test("3. a B2A envelope signed by a machine key that is not B's pin opens at A but verifies nowhere and reaches nothing", async () => {
  const s = await openStack();
  const evil = await evilReady;
  try {
    // The plane (or anyone) holds A's PUBLIC encryption key and can seal at
    // will (spec §5.6's first line): the envelope opens. Only the signature
    // can name the origin, and the evil key is not B's pin.
    const forged = await sealB2A(s, {
      agentBytes: Buffer.from([11]),
      seq: 0,
      nB: newNonce(),
      signerPrivateJwk: evil.privateJwk,
    });
    // Openability witness: the SAME envelope decrypts at A (openB2A resolves),
    // so the refusal below is the SIGNATURE stage, not a decryption failure.
    // Had sealB2A mis-sealed this to the wrong recipient, openB2A would reject
    // here and the case would fail loudly instead of passing vacuously.
    await openB2A(s, forged);
    // ...and decodeB2A (open THEN verify against B's pin) rejects naming the
    // signature, which a wrong-recipient seal would instead die a DecryptError.
    await expect(decodeB2A(s, forged)).rejects.toThrow(/signature is invalid/);
    s.routeFromNode("b-node", forged);
    await sleep(60);
    expect(s.forwarded()).toEqual([]); // the key home never saw the request
    expect(producedByA(s)).toBe(0); // and a forgery costs no answer: no signature oracle
    expect(ingress(s).length).toBe(1); // the only thing the plane routed was the forged B2A
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 4. scope-before-forward, after a correctly filtered roster          */
/* ------------------------------------------------------------------ */

test("4. after the filtered roster answer, a SIGN_REQUEST for the UNGRANTED blob is refused at A: A's agent is never asked to sign it", async () => {
  const s = await openStack();
  try {
    const p = paneAt(s.result.socketPath);
    p.conn.write(framed(Buffer.from([11])));
    await waitUntil(() => p.payloads().length === 1, "the roster answer");
    const roster = parseAnswer(p.payloads()[0]);
    expect(roster.type).toBe(12);
    expect(roster.count).toBe(1); // two keys on A's agent, one key for the pane
    expect(roster.comments).toEqual(["granted key"]);

    p.conn.write(framed(buildSignRequestTenX(KEY_OUT))); // the blob the roster never showed
    await waitUntil(() => p.payloads().length === 2, "the refusal");
    expect([...p.payloads()[1]]).toEqual([5]);

    const fwd = s.forwarded();
    expect(fwd.length).toBe(1); // ONLY the identities request went to A's agent
    expect(fwd[0]).toEqual(Buffer.from([11]));
    for (const seen of s.stub.received) {
      if (seen[0] === 13) expect(seen.length).toBe(1); // byte 13 in the stub's view is only the probe
    }
    expect(producedByA(s)).toBe(2); // both answers came back, but the second is a refusal, not a signature
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 5. the relayed blob is byte-opaque AT THE PLANE                     */
/* ------------------------------------------------------------------ */

test("5. a full exchange leaves no plaintext anywhere the plane can see: wire capture, audits, session view, broker log", async () => {
  const s = await openStack();
  try {
    const p = paneAt(s.result.socketPath);
    const signRequest = buildSignRequestTenX(KEY_IN, { data: Buffer.from("DATA-SECRET") });
    p.conn.write(framed(Buffer.from([11])));
    await waitUntil(() => p.payloads().length === 1, "the roster");
    p.conn.write(framed(signRequest));
    await waitUntil(() => p.payloads().length === 2, "the signature");

    const signResponse = p.payloads()[1];
    // Only full multi-field payloads ride the marker list: a one-byte
    // request's two-character base64 would "collide" inside random
    // ciphertext by chance and tell us nothing.
    const payloadB64 = [signRequest, signResponse].flatMap((b) => [
      b.toString("base64"),
      base64UrlNoPad(new Uint8Array(b)),
    ]);
    const markers = [
      "KEY-IN",
      "KEY-OUT",
      "ssh-ed25519",
      "granted key",
      "ungranted key",
      "DATA-SECRET", // markers containing a hyphen or a space cannot occur inside base64 by chance
    ];

    // Scan every string the plane holds BEFORE the close, then force the
    // close audit and scan again (the lifetime audit rides the close).
    const sessionView = JSON.stringify(s.broker.sessionInfo(s.result.ref));
    const beforeClose = [...s.planeVisible(), sessionView];
    expect(await s.broker.closeRelay(s.result.ref, "child-exit")).toBe(true);
    const afterClose = s.planeVisible();

    const blobs = ingress(s).map((f) => f.blob);
    expect(blobs.length).toBeGreaterThanOrEqual(4); // two requests and two answers crossed
    for (const text of [...beforeClose, ...afterClose]) {
      for (const marker of markers) expect(text).not.toContain(marker);
      for (const form of payloadB64) expect(text).not.toContain(form);
    }
    for (const blob of blobs) {
      // The opaque envelope itself never leaks into a durable structure:
      // audits and the session view carry ids and paths, never relay bytes.
      for (const a of s.audits) expect(a.metadataJson).not.toContain(blob);
      expect(sessionView).not.toContain(blob);
    }

    // The audit census is the shipped posture: routing ids, hosts, the
    // reason, and the fingerprint COUNT (never the set) - and no fingerprints.
    const open = s.audits.find((a) => a.action === "node.ssh_relay.open");
    const close = s.audits.find((a) => a.action === "node.ssh_relay.close");
    expect(open).toBeDefined();
    expect(close).toBeDefined();
    expect(open?.metadata.fingerprintCount).toBe(1);
    expect(Object.keys(open?.metadata ?? {}).sort()).toEqual(
      ["aNodeId", "bNodeId", "fingerprintCount", "grantId", "lifetimeMs", "paneId", "ref", "relayId"].sort(),
    );
    expect(close?.metadata.reason).toBe("child-exit");
    for (const a of s.audits) {
      expect(a.metadataJson).not.toContain(fp(KEY_IN));
      expect(a.metadataJson).not.toContain(fp(KEY_OUT));
    }
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 6. replay inertness: inside the window, and into a ref-reuse        */
/* ------------------------------------------------------------------ */

test("6. a captured envelope is INERT replayed inside the lifetime and inert replayed into a later session on the reused routing ref", async () => {
  const s = await openStack();
  try {
    const p = paneAt(s.result.socketPath);
    const request = buildSignRequestTenX(KEY_IN);
    p.conn.write(framed(request));
    await waitUntil(() => p.payloads().length === 1, "the genuine signature");
    const inF = ingress(s);
    const b2a = inF[0];
    const a2b = inF[1];
    const decReq = await decodeB2A(s, b2a);
    const decRep = await decodeA2B(s, a2b);

    // (a) inside the lifetime window.
    // (a1) the byte-identical B2A resend (the plane routes what it already
    // routed): refused by the binding flip (the recorded nA must ride) and,
    // whatever path refuses it, A asks its agent nothing and answers nothing.
    s.routeFromNode("b-node", JSON.parse(JSON.stringify(b2a)) as RelayFrame);
    await sleep(60);
    expect(s.forwarded().length).toBe(1);
    expect(producedByA(s)).toBe(1);
    expect(p.payloads().length).toBe(1);

    // (a2) a freshly signed B2A that passes EVERY binding except seq: the
    // signed anti-replay value goes backwards, so the SeqGate alone refuses.
    const rewind = await sealB2A(s, {
      agentBytes: request,
      seq: 0,
      nB: decReq.nB,
      ...(decRep.nA === undefined ? {} : { nA: decRep.nA }),
      signerPrivateJwk: s.bId.signingPrivateJwk,
    });
    // Openability witness: the refused envelope opens AND verifies end to end
    // (decodeB2A runs A's open+verify checklist with NO gate - the gate is the
    // responder's own next step), so the live refusal below can only be the
    // SeqGate's. A sealB2A that sealed to the wrong recipient would throw
    // right here, failing this case instead of refusing for the wrong reason.
    expect((await decodeB2A(s, rewind)).agentBytes).toEqual(request);
    s.routeFromNode("b-node", rewind);
    await sleep(60);
    expect(s.forwarded().length).toBe(1);
    expect(producedByA(s)).toBe(1);

    // (a3) the captured A2B replayed toward B: refused by B's gate; the pane
    // stream gains nothing and the connection is not punished for it.
    s.routeFromNode("a-node", JSON.parse(JSON.stringify(a2b)) as RelayFrame);
    await sleep(60);
    expect(p.payloads().length).toBe(1);
    expect(p.closed()).toBe(false);

    // (b) the crown jewel: both machines end this pairing and a LATER
    // session re-presents the SAME routing ref with a fresh relay id and
    // fresh endpoint state. The ref is `crypto.randomUUID()` per pairing, so
    // the broker itself would never re-issue it; what the test forces is the
    // state the plane is actually in when a ref somehow comes back: it routes
    // the ref blindly (it never sees relay ids or nonces), so only the
    // ENDPOINTS' bindings can make the old bytes inert.
    s.closeNodeSessions(s.result.ref, "child-exit");
    expect(s.aRelay.has(s.result.ref)).toBe(false);
    expect(s.bRelay.has(s.result.ref)).toBe(false);
    expect(s.broker.sessionInfo(s.result.ref)).not.toBeNull(); // the plane's lane for the ref is still open
    const cmd2 = (role: "A" | "B"): SshRelayOpenCommand => ({
      type: "ssh_relay_open",
      relayId: "relay-second",
      ref: s.result.ref,
      role,
      aNodeId: "a-node",
      bNodeId: "b-node",
      peerSigningPublicKey: role === "A" ? s.bId.signingPublicJwk : s.aId.signingPublicJwk,
      peerEncryptPublicKey: b64Jwk(role === "A" ? s.bId.publicJwk : s.aId.publicJwk),
      grantId: "grant-1",
      fingerprints: [fp(KEY_IN)],
      lifetimeMs: SSH_RELAY_LIFETIME_MS,
      paneId: PANE_ID,
      hostPin: `git.example.test ssh-ed25519 ${"A".repeat(51)}`,
    });
    await openARelaySession({
      relay: s.aRelay,
      dataDir: s.aDir,
      selfNodeId: "a-node",
      cmd: cmd2("A"),
      sendRelayFrame: (f) => s.routeFromNode("a-node", f),
      resolveAgentSocket: () => s.stub.path,
    });
    await openBRelaySession({
      relay: s.bRelay,
      dataDir: s.bDir,
      selfNodeId: "b-node",
      paneId: PANE_ID,
      cmd: cmd2("B"),
      sendRelayFrame: (f) => s.routeFromNode("b-node", f),
    });
    const fwdBase = s.forwarded().length; // session 2's open re-probed; baseline moves
    const aProducedBase = producedByA(s);

    // (b1) the old relayId, old-nonce, old-seq B2A envelope, replayed into
    // the session that shares its ref: A's session-2 responder opens it (the
    // key home never moved) and EXACTLY one binding refuses it: the signed
    // relaySessionId claim (the bytes carry session 1's id, this responder was
    // opened under relay-second). The endpoint nonces refuse nothing at this
    // point: session 2 has recorded no nB and has not flipped bindNA, so its
    // checklist omits both nonce members; and the fresh gate would have
    // ACCEPTED seq 0, had the verification ever passed.
    s.routeFromNode("b-node", JSON.parse(JSON.stringify(b2a)) as RelayFrame);
    await sleep(60);
    expect(s.forwarded().length).toBe(fwdBase);
    expect(producedByA(s)).toBe(aProducedBase);

    // (b2) the old A2B envelope replayed at session 2's idle proxy: nothing
    // is written to any pane socket by it.
    const p2 = paneAt(s.result.socketPath);
    s.routeFromNode("a-node", JSON.parse(JSON.stringify(a2b)) as RelayFrame);
    await sleep(60);
    expect(p2.payloads().length).toBe(0);

    // (b3) and session 2 itself is healthy: a genuine sign completes on it,
    // proving the refusals above refused the FORGERY, not the session.
    p2.conn.write(framed(buildSignRequestTenX(KEY_IN)));
    await waitUntil(() => p2.payloads().length === 1, "session 2's own signature");
    expect([...p2.payloads()[0]]).toEqual([14, 0, 0, 0, 3, ...Buffer.from("SIG")]);
    p2.destroy();
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 7. multi-key session: several granted keys, strictly increasing seq */
/* ------------------------------------------------------------------ */

test("7. a multi-key session: SIGN_REQUESTs for two granted keys at strictly increasing seqs both complete", async () => {
  const s = await openStack({ fingerprints: [fp(KEY_IN), fp(KEY_OUT)] });
  try {
    const p = paneAt(s.result.socketPath);
    const req1 = buildSignRequestTenX(KEY_IN, { data: Buffer.from("DATA-IN") });
    const req2 = buildSignRequestTenX(KEY_OUT, { data: Buffer.from("DATA-OUT") });
    p.conn.write(framed(req1));
    await waitUntil(() => p.payloads().length === 1, "the first signature");
    p.conn.write(framed(req2));
    await waitUntil(() => p.payloads().length === 2, "the second signature");
    expect([...p.payloads()[0]]).toEqual([14, 0, 0, 0, 3, ...Buffer.from("SIG")]);
    expect([...p.payloads()[1]]).toEqual([14, 0, 0, 0, 3, ...Buffer.from("SIG")]);
    expect(s.forwarded()).toEqual([req1, req2]);

    const inF = ingress(s);
    const b2a = inF.filter((f) => f.direction === "B2A");
    const a2b = inF.filter((f) => f.direction === "A2B");
    expect(b2a.length).toBe(2);
    expect(a2b.length).toBe(2);
    const signedB2A = await Promise.all(b2a.map((f) => decodeB2A(s, f)));
    const signedA2B = await Promise.all(a2b.map((f) => decodeA2B(s, f)));
    expect(signedB2A.map((d) => d.seq)).toEqual([0, 1]); // the SIGNED seqs are strictly increasing
    expect(signedA2B.map((d) => d.seq)).toEqual([0, 1]);
    expect(new Set(signedB2A.map((d) => d.nB)).size).toBe(1); // one session, one pair of nonces
    expect(new Set(signedA2B.map((d) => d.nA)).size).toBe(1);
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 8. a resent or non-increasing seq is refused, both directions       */
/* ------------------------------------------------------------------ */

test("8. a resent envelope and a non-increasing signed seq are refused in BOTH directions, and the session still serves the next request", async () => {
  const s = await openStack();
  try {
    const p = paneAt(s.result.socketPath);
    const request = buildSignRequestTenX(KEY_IN);
    p.conn.write(framed(request));
    await waitUntil(() => p.payloads().length === 1, "the genuine signature");
    const inF = ingress(s);

    // B2A direction, byte-identical resend (the plane can resend any envelope).
    s.routeFromNode("b-node", JSON.parse(JSON.stringify(inF[0])) as RelayFrame);
    await sleep(50);
    expect(s.forwarded().length).toBe(1);
    expect(producedByA(s)).toBe(1);

    // B2A direction, a freshly signed envelope whose seq does not advance
    // (every other binding correct): the gate alone refuses it.
    const decReq = await decodeB2A(s, inF[0]);
    const decRep = await decodeA2B(s, inF[1]);
    const sameSeq = await sealB2A(s, {
      agentBytes: request,
      seq: 0,
      nB: decReq.nB,
      ...(decRep.nA === undefined ? {} : { nA: decRep.nA }),
      signerPrivateJwk: s.bId.signingPrivateJwk,
    });
    // Openability witness (case 6(a2)'s same guard): every check before the
    // gate passes for this exact envelope, so the refusal below is the gate's
    // alone. A mis-sealed fixture would throw here, not pass vacuously.
    expect((await decodeB2A(s, sameSeq)).agentBytes).toEqual(request);
    s.routeFromNode("b-node", sameSeq);
    await sleep(50);
    expect(s.forwarded().length).toBe(1);
    expect(producedByA(s)).toBe(1);

    // A2B direction: the captured answer resent toward B; the pane's stream
    // gains no duplicate and the connection lives.
    s.routeFromNode("a-node", JSON.parse(JSON.stringify(inF[1])) as RelayFrame);
    await sleep(50);
    expect(p.payloads().length).toBe(1);
    expect(p.closed()).toBe(false);

    // Both gates moved forward, so the session continues: request two answers
    // at signed seq 1 in each direction.
    p.conn.write(framed(request));
    await waitUntil(() => p.payloads().length === 2, "the next genuine signature");
    const secondA2B = ingress(s)
      .filter((f) => f.direction === "A2B")
      .at(-1);
    expect((await decodeA2B(s, secondA2B as RelayFrame)).seq).toBe(1);
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 9. B rejects a forged or garbled A2B: nothing reaches the socket    */
/* ------------------------------------------------------------------ */

test("9. a forged A2B signature fails the pane's connection without a byte written, and a garbled envelope is noise that costs the session nothing", async () => {
  const s = await openStack();
  const evil = await evilReady;
  try {
    const p = paneAt(s.result.socketPath);
    const request = buildSignRequestTenX(KEY_IN);
    p.conn.write(framed(request));
    await waitUntil(() => p.payloads().length === 1, "the genuine first signature");
    const inF = ingress(s);
    const decReq = await decodeB2A(s, inF[0]);
    const decRep = await decodeA2B(s, inF[1]);

    // Request two, with the plane withholding A's answer so the slot stays
    // open: the forged reply races nothing.
    s.swallowB2A = true;
    p.conn.write(framed(request));
    await waitUntil(
      () => ingress(s).filter((f) => f.direction === "B2A").length === 2,
      "the second request reaches the plane",
    );
    const forged = await sealA2B(s, {
      agentBytes: Buffer.concat([Buffer.from([14]), sshStr(Buffer.from("EVIL-SIG"))]),
      seq: 1,
      nB: decReq.nB,
      ...(decRep.nA === undefined ? {} : { nA: decRep.nA }),
      signerPrivateJwk: evil.privateJwk, // opens (sealed to B's public half), verifies against nobody's pin
    });
    s.routeFromNode("a-node", forged);
    await waitUntil(() => p.closed(), "the forged reply fails the waiting connection");
    expect(p.payloads().length).toBe(1); // the refused frame wrote nothing...
    for (const pl of p.payloads()) expect(pl.includes(Buffer.from("EVIL-SIG"))).toBe(false); // ...and it was never the forged bytes

    // A's late answer to the dead request 2 is absorbed by the burned slot.
    s.swallowB2A = false;
    s.releaseB2A();
    await sleep(30);

    // The garble, against a fresh connection: valid base64, broken JWE bytes.
    const p3 = paneAt(s.result.socketPath);
    s.swallowB2A = true;
    p3.conn.write(framed(request));
    await waitUntil(
      () => ingress(s).filter((f) => f.direction === "B2A").length === 3,
      "the third request reaches the plane",
    );
    const garbled: RelayFrame = { ...inF[1], blob: garbleBlob(inF[1].blob) }; // the genuine answer's envelope, one byte broken
    s.routeFromNode("a-node", garbled);
    await sleep(50);
    expect(p3.payloads().length).toBe(0); // an unopenable envelope writes nothing
    expect(p3.closed()).toBe(false); // ...and is noise, not a forgery: the session lives
    s.swallowB2A = false;
    s.releaseB2A(); // A's real answer to request 3 lands: the garble cost the session nothing
    await waitUntil(() => p3.payloads().length === 1, "the real answer after the garbled noise");
    expect([...p3.payloads()[0]]).toEqual([14, 0, 0, 0, 3, ...Buffer.from("SIG")]);
    p3.destroy();
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 10. the roster command: answered with no grant, no relay session    */
/* ------------------------------------------------------------------ */

// Matrix case 10, flipped from the Task 9 todo now that the command exists
// (spec 2026-10-08 §5.4, Task 11). The whole matrix stack is deliberately
// ABSENT: there is no broker, no grant, no pairing, and no B. The point of
// the case is that the roster read needs none of that - A's live agent and
// A's own gate mirror are its entire world.
test("10. ssh_agent_identities is accepted with no grant and no relay session: the WHOLE roster answers, blobs withheld", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subshell-relay-roster-"));
  const stub = await startStubAgent(ROSTER, OPENSSH_10X_SCHEME);
  writeSshEnabled(dir, { on: true, changedAt: "2026-10-08T10:00:00.000Z" });
  const savedSock = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = stub.path; // the handler's production socket lookup, over a real round trip
  try {
    // The arm dispatch would run, on the same data-dir-only context the node
    // suite builds; routing of the type is the node suite's own pin.
    const result = await execSshAgentIdentities({ config: { dataDir: dir } } as unknown as CommandContext);
    expect(result.ok).toBe(true);
    const roster = parseNodeSshAgentIdentities(result.ok ? result.data : null);
    expect(roster).not.toBeNull();
    // The WHOLE roster, not a grant-filtered one: with nothing granted there
    // is no set to scope by, and the approval screen must show both keys.
    expect(roster?.identities).toEqual([
      { fingerprint: fp(KEY_IN), comment: "granted key" },
      { fingerprint: fp(KEY_OUT), comment: "ungranted key" },
    ]);
    // The blobs are withheld: neither wire encoding of either blob appears
    // anywhere in the serialized result frame.
    const wire = JSON.stringify(result);
    for (const blob of [KEY_IN, KEY_OUT]) {
      expect(wire).not.toContain(blob.toString("base64"));
      expect(wire).not.toContain(blob.toString("base64url"));
    }
    // Only one-byte requests ever reached the agent: the classic candidate
    // (13) confirmed FAILURE, the 10.x candidate (11) resolved the scheme
    // positively, and the roster was asked in the RESOLVED numbering. No
    // sign body, no session byte: nothing the responder's rules exclude.
    expect(stub.received).toEqual([Buffer.from([13]), Buffer.from([11]), Buffer.from([11])]);
    // Nothing was written anywhere the read could not already see: the data
    // dir holds exactly the gate mirror, no session state, no audit artifact.
    expect(readdirSync(dir)).toEqual(["ssh-enabled.json"]);
  } finally {
    if (savedSock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = savedSock;
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

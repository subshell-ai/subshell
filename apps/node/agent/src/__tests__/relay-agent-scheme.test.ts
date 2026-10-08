import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type AgentScheme,
  CLASSIC_SCHEME,
  filterIdentitiesAnswer,
  fingerprintAgentBlob,
  OPENSSH_10X_SCHEME,
  parseIdentitiesAnswer,
  parseSignRequest,
  parseSignResponse,
  probeAgentScheme,
  SSH2_AGENT_FAILURE,
} from "../relay-agent-scheme.js";

/**
 * Byte-literal fixtures for the two ssh-agent numbering schemes the A-side
 * responder probes between (spec 2026-10-08 §5.4, ruling 2026-10-08): the
 * RFC 9987 numbering OpenSSH 10.x ships (identities 11 / answer 12 / sign 13 /
 * sign response 14, sign carrying the extended grammar) and OpenSSH's classic
 * numbering (13 / 14 / 15 / 16). Every codepoint here is written as a plain
 * number - the constants are asserted AGAINST the literals, never derived
 * from the production module, so numeric drift cannot hide. The FAILURE(5)
 * answers mirror the live measurement on this fleet's OpenSSH_10.2p1: a byte
 * 13 (a truncated sign under 10.x) answers FAILURE, and a byte 11 answers 12.
 */

/* ---------------- the agent wire, spelled by hand ---------------- */

function be32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** An SSH string on the agent wire: 4-byte BE length + bytes. */
function sshStr(bytes: Buffer | string): Buffer {
  const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.concat([be32(b.length), b]);
}

/** An independent fingerprint oracle: SHA-256 over the wire blob, base64url no pad. */
function fp(wire: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(wire).digest("base64url")}`;
}

const KEY_A = Buffer.concat([sshStr("ssh-ed25519"), sshStr(Buffer.from("KEY-A"))]);
const KEY_B = Buffer.concat([sshStr("ssh-ed25519"), sshStr(Buffer.from("KEY-B"))]);

/** An IDENTITIES_ANSWER spelled in ONE scheme's answer byte, from raw numbers. */
function answerWith(answerByte: number, entries: { blob: Buffer; comment: string }[]): Buffer {
  return Buffer.concat([
    Buffer.from([answerByte]),
    be32(entries.length),
    ...entries.flatMap((e) => [sshStr(e.blob), sshStr(e.comment)]),
  ]);
}

/* ---------------- the scheme data: measured literals ---------------- */

test("the schemes carry the measured codepoints and collide exactly where the ruling says", () => {
  // RFC 9987 numbering, shipped by OpenSSH 10.x (measured OpenSSH_10.2p1:
  // request 11 answers 12; request 13 and 15 answer FAILURE 5).
  expect([OPENSSH_10X_SCHEME.identities, OPENSSH_10X_SCHEME.answer]).toEqual([11, 12]);
  expect([OPENSSH_10X_SCHEME.sign, OPENSSH_10X_SCHEME.signResponse]).toEqual([13, 14]);
  expect(OPENSSH_10X_SCHEME.extendedSign).toBe(true);
  // OpenSSH's classic numbering: identities 13 / answer 14 / sign 15 / response 16.
  expect([CLASSIC_SCHEME.identities, CLASSIC_SCHEME.answer]).toEqual([13, 14]);
  expect([CLASSIC_SCHEME.sign, CLASSIC_SCHEME.signResponse]).toEqual([15, 16]);
  expect(CLASSIC_SCHEME.extendedSign).toBe(false);
  // SSH2_AGENT_FAILURE is 5 in both (the measurement's third probe).
  expect(SSH2_AGENT_FAILURE).toBe(5);
  // The collisions the probe exists to resolve: 13 is classic identities but
  // 10.x sign; 14 is classic answer but 10.x sign response.
  expect(CLASSIC_SCHEME.identities).toBe(OPENSSH_10X_SCHEME.sign);
  expect(CLASSIC_SCHEME.answer).toBe(OPENSSH_10X_SCHEME.signResponse);
});

/* ---------------- fingerprint spelling (the grant grammar) ---------------- */

test("fingerprintAgentBlob spells SHA256 over the wire blob in the grant grammar's base64url form", () => {
  const s = fingerprintAgentBlob(Buffer.from("hello"));
  expect(s).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
  expect(s).toBe(fp(Buffer.from("hello")));
});

/* ---------------- IDENTITIES_ANSWER parsing and filtering ---------------- */

test("parseIdentitiesAnswer accepts only the resolved scheme's answer byte", () => {
  const tenX = answerWith(12, [{ blob: KEY_A, comment: "a" }]);
  const classic = answerWith(14, [{ blob: KEY_A, comment: "a" }]);
  expect(parseIdentitiesAnswer(tenX, OPENSSH_10X_SCHEME).map((e) => e.comment.toString())).toEqual(["a"]);
  expect(parseIdentitiesAnswer(classic, CLASSIC_SCHEME).map((e) => e.comment.toString())).toEqual(["a"]);
  // Byte 14 is the ANSWER under classic and the SIGN RESPONSE under 10.x:
  // a resolver must never accept it as a roster in the wrong scheme.
  expect(() => parseIdentitiesAnswer(classic, OPENSSH_10X_SCHEME)).toThrow();
  expect(() => parseIdentitiesAnswer(tenX, CLASSIC_SCHEME)).toThrow();
});

test("parseIdentitiesAnswer refuses truncated entries and trailing bytes", () => {
  const full = answerWith(12, [{ blob: KEY_A, comment: "a" }]);
  expect(() => parseIdentitiesAnswer(full.subarray(0, full.length - 1), OPENSSH_10X_SCHEME)).toThrow();
  expect(() => parseIdentitiesAnswer(Buffer.concat([full, Buffer.from([0])]), OPENSSH_10X_SCHEME)).toThrow();
  // A declared count the buffer does not carry.
  const overcounted = Buffer.concat([Buffer.from([12]), be32(2), sshStr(KEY_A), sshStr("a")]);
  expect(() => parseIdentitiesAnswer(overcounted, OPENSSH_10X_SCHEME)).toThrow();
  // The shortest legal answer: type + count 0.
  expect(parseIdentitiesAnswer(Buffer.from([12, 0, 0, 0, 0]), OPENSSH_10X_SCHEME)).toEqual([]);
});

test("filterIdentitiesAnswer keeps granted entries byte-identical under BOTH schemes' answer byte", () => {
  const roster = [
    { blob: KEY_A, comment: "granted" },
    { blob: KEY_B, comment: "not granted" },
  ];
  const allowed = new Set([fp(KEY_B)]); // grant the SECOND entry: order must not matter
  for (const [scheme, answerByte] of [
    [OPENSSH_10X_SCHEME, 12],
    [CLASSIC_SCHEME, 14],
  ] as [AgentScheme, number][]) {
    const filtered = filterIdentitiesAnswer(answerWith(answerByte, roster), allowed, scheme);
    // The rebuilt answer carries THIS scheme's answer byte - not a foreign
    // one, and never the first pass's invented 2.
    expect([...filtered]).toEqual([answerByte, 0, 0, 0, 1, ...sshStr(KEY_B), ...sshStr("not granted")]);
    expect(parseIdentitiesAnswer(filtered, scheme)).toEqual([{ blob: KEY_B, comment: Buffer.from("not granted") }]);
  }
  // An empty grant serves the count-zero answer, five bytes, nothing else.
  expect([...filterIdentitiesAnswer(answerWith(12, roster), new Set(), OPENSSH_10X_SCHEME)]).toEqual([12, 0, 0, 0, 0]);
  // A malformed answer throws (the responder must refuse it, never forward).
  expect(() => filterIdentitiesAnswer(Buffer.from([12, 0, 0]), new Set(), OPENSSH_10X_SCHEME)).toThrow();
  expect(() => filterIdentitiesAnswer(answerWith(14, roster), new Set([fp(KEY_A)]), OPENSSH_10X_SCHEME)).toThrow();
});

/* ---------------- SIGN_REQUEST grammar: classic and extended ---------------- */

test("parseSignRequest accepts the classic body (blob, data, flags) in the classic scheme", () => {
  const body = Buffer.concat([Buffer.from([15]), sshStr(KEY_A), sshStr("DATA"), be32(0)]);
  const parsed = parseSignRequest(body, CLASSIC_SCHEME);
  expect(parsed.keyBlob).toEqual(KEY_A);
  expect(parsed.data).toEqual(Buffer.from("DATA"));
  expect(parsed.flags).toBe(0);
  expect(parsed.algorithms).toBeUndefined();
});

test("parseSignRequest accepts the extended 10.x body (trailing algorithms string) and the bare form", () => {
  const bare = Buffer.concat([Buffer.from([13]), sshStr(KEY_A), sshStr("DATA"), be32(1)]);
  expect(parseSignRequest(bare, OPENSSH_10X_SCHEME).algorithms).toBeUndefined();
  const extended = Buffer.concat([
    Buffer.from([13]),
    sshStr(KEY_A),
    sshStr("DATA"),
    be32(0),
    sshStr("ssh-ed25519,rsa-sha2-512"),
  ]);
  expect(parseSignRequest(extended, OPENSSH_10X_SCHEME).algorithms).toEqual(Buffer.from("ssh-ed25519,rsa-sha2-512"));
});

test("parseSignRequest refuses every malformed body in both schemes", () => {
  const bare = (scheme: AgentScheme, tail: Buffer): Buffer =>
    Buffer.concat([Buffer.from([scheme.sign]), sshStr(KEY_A), tail]);
  // Blob-only (no data, no flags): a body the wire never legally carries.
  expect(() => parseSignRequest(bare(CLASSIC_SCHEME, Buffer.alloc(0)), CLASSIC_SCHEME)).toThrow();
  expect(() => parseSignRequest(bare(OPENSSH_10X_SCHEME, Buffer.alloc(0)), OPENSSH_10X_SCHEME)).toThrow();
  // The first pass's invented blob+flags shape: still not the wire grammar.
  expect(() => parseSignRequest(bare(CLASSIC_SCHEME, be32(0)), CLASSIC_SCHEME)).toThrow();
  // Truncated string lengths, missing flags, trailing garbage.
  expect(() =>
    parseSignRequest(Buffer.concat([Buffer.from([15]), Buffer.from([0, 0, 0, 9]), KEY_A]), CLASSIC_SCHEME),
  ).toThrow();
  expect(() =>
    parseSignRequest(Buffer.concat([Buffer.from([15]), sshStr(KEY_A), sshStr("DATA")]), CLASSIC_SCHEME),
  ).toThrow();
  expect(() =>
    parseSignRequest(
      Buffer.concat([Buffer.from([15]), sshStr(KEY_A), sshStr("DATA"), be32(0), Buffer.from([0, 0])]),
      CLASSIC_SCHEME,
    ),
  ).toThrow();
  // A trailing algorithms string is legal only under the extended scheme,
  // and it must itself be well-formed there.
  const trailing = Buffer.concat([Buffer.from([13]), sshStr(KEY_A), sshStr("DATA"), be32(0), sshStr("algos")]);
  expect(() => parseSignRequest(trailing, CLASSIC_SCHEME)).toThrow();
  expect(() =>
    parseSignRequest(
      Buffer.concat([Buffer.from([13]), sshStr(KEY_A), sshStr("DATA"), be32(0), Buffer.from([0, 0, 0, 99])]),
      OPENSSH_10X_SCHEME,
    ),
  ).toThrow();
  // An empty key blob names nothing to scope: refused.
  expect(() =>
    parseSignRequest(
      Buffer.concat([Buffer.from([13]), sshStr(Buffer.alloc(0)), sshStr("DATA"), be32(0)]),
      OPENSSH_10X_SCHEME,
    ),
  ).toThrow();
});

/* ---------------- SIGN_RESPONSE: the body the relay gate accepts ---------------- */

test("parseSignResponse accepts exactly the type byte plus one string in each scheme", () => {
  // The collision this strictness exists for, pinned: classic answer 14 ==
  // 10.x signResponse 14. The type byte alone cannot tell a signature from a
  // foreign scheme's roster; only the body parse can.
  expect(CLASSIC_SCHEME.answer).toBe(14);
  expect(OPENSSH_10X_SCHEME.signResponse).toBe(14);
  expect(parseSignResponse(Buffer.concat([Buffer.from([14]), sshStr(Buffer.from("SIG"))]), OPENSSH_10X_SCHEME)).toEqual(
    Buffer.from("SIG"),
  );
  expect(parseSignResponse(Buffer.concat([Buffer.from([16]), sshStr(Buffer.from("SIG"))]), CLASSIC_SCHEME)).toEqual(
    Buffer.from("SIG"),
  );
});

test("parseSignResponse refuses a roster-shaped body, extra bytes, truncation, and a foreign type byte", () => {
  // A multi-entry roster spelled under the SIGN_RESPONSE byte (the exact
  // shape a mid-session classic swap answers a forwarded 13 with): refused.
  const roster = Buffer.concat([Buffer.from([14]), be32(2), sshStr(KEY_A), sshStr("a"), sshStr(KEY_B), sshStr("b")]);
  expect(() => parseSignResponse(roster, OPENSSH_10X_SCHEME)).toThrow();
  expect(() =>
    parseSignResponse(Buffer.concat([Buffer.from([16]), be32(1), sshStr(KEY_A), sshStr("a")]), CLASSIC_SCHEME),
  ).toThrow();
  // Bytes after the one signature string: not the wire shape.
  expect(() =>
    parseSignResponse(
      Buffer.concat([Buffer.from([14]), sshStr(Buffer.from("SIG")), Buffer.from([0])]),
      OPENSSH_10X_SCHEME,
    ),
  ).toThrow();
  // Empty body and a truncated length prefix.
  expect(() => parseSignResponse(Buffer.from([14]), OPENSSH_10X_SCHEME)).toThrow();
  expect(() => parseSignResponse(Buffer.from([14, 0, 0, 0]), OPENSSH_10X_SCHEME)).toThrow();
  // A foreign scheme's response byte is refused in the resolved scheme.
  expect(() => parseSignResponse(Buffer.concat([Buffer.from([16]), sshStr("S")]), OPENSSH_10X_SCHEME)).toThrow();
  expect(() => parseSignResponse(Buffer.concat([Buffer.from([14]), sshStr("S")]), CLASSIC_SCHEME)).toThrow();
});

/* ---------------- the probe: resolving the live agent's numbering ---------------- */

/** Records every payload a fake agent received and answers per a script. */
function scriptedAgent(answer: (payload: Buffer) => Buffer | "throw"): {
  sent: Buffer[];
  requestAgent: (socketPath: string, payload: Buffer) => Promise<Buffer>;
} {
  const sent: Buffer[] = [];
  return {
    sent,
    requestAgent: async (_socketPath: string, payload: Buffer): Promise<Buffer> => {
      sent.push(Buffer.from(payload));
      const a = answer(payload);
      if (a === "throw") throw new Error("connect refused");
      return a;
    },
  };
}

const EMPTY_ANSWER_12 = Buffer.from([12, 0, 0, 0, 0]);
const EMPTY_ANSWER_14 = Buffer.from([14, 0, 0, 0, 0]);

test("the probe resolves openssh-10x from the 11-to-12 answer after the classic candidate answers FAILURE", async () => {
  // The measured OpenSSH_10.2p1 pair: byte 13 (a truncated sign) answers 5,
  // byte 11 (identities) answers a valid 12.
  const agent = scriptedAgent((p) => {
    if (p.equals(Buffer.from([13]))) return Buffer.from([5]);
    if (p.equals(Buffer.from([11]))) return EMPTY_ANSWER_12;
    return "throw";
  });
  const scheme = await probeAgentScheme("/fake/agent.sock", agent.requestAgent);
  expect(scheme).toBe(OPENSSH_10X_SCHEME);
  expect(agent.sent).toEqual([Buffer.from([13]), Buffer.from([11])]);
});

test("the probe resolves classic from the 13-to-14 answer in a single probe", async () => {
  const agent = scriptedAgent((p) => (p.equals(Buffer.from([13])) ? EMPTY_ANSWER_14 : Buffer.from([5])));
  const scheme = await probeAgentScheme("/fake/agent.sock", agent.requestAgent);
  expect(scheme).toBe(CLASSIC_SCHEME);
  // The classic agent answered the first candidate: no second probe is sent.
  expect(agent.sent).toEqual([Buffer.from([13])]);
});

test("an agent that answers FAILURE to both candidates resolves to nothing, never a guessed scheme", async () => {
  const agent = scriptedAgent(() => Buffer.from([5]));
  expect(await probeAgentScheme("/fake/agent.sock", agent.requestAgent)).toBeNull();
  expect(agent.sent).toEqual([Buffer.from([13]), Buffer.from([11])]);
});

test("a probe answer must PARSE as an IDENTITIES_ANSWER: a bare type byte confirms nothing", async () => {
  // Type 14 with a truncated body is not a valid classic answer (and is what
  // a 10.x SIGN_RESPONSE byte would look like); the probe must move on and
  // confirm 10.x positively.
  const agent = scriptedAgent((p) => {
    if (p.equals(Buffer.from([13]))) return Buffer.from([14, 0, 0, 0, 2, 0, 0, 0, 1, 65]);
    if (p.equals(Buffer.from([11]))) return EMPTY_ANSWER_12;
    return Buffer.from([5]);
  });
  expect(await probeAgentScheme("/fake/agent.sock", agent.requestAgent)).toBe(OPENSSH_10X_SCHEME);
  expect(agent.sent.length).toBe(2);
});

test("an unknown answer byte and a transport failure both move the probe on and resolve to nothing", async () => {
  const junk = scriptedAgent(() => Buffer.from([99]));
  expect(await probeAgentScheme("/fake/agent.sock", junk.requestAgent)).toBeNull();
  expect(junk.sent.length).toBe(2);
  const dead = scriptedAgent(() => "throw");
  expect(await probeAgentScheme("/fake/agent.sock", dead.requestAgent)).toBeNull();
  expect(dead.sent.length).toBe(2); // every candidate was tried before giving up
});

test("the probe never sends anything but one-byte identities requests (a probe must never reach a signature)", async () => {
  const agent = scriptedAgent(() => Buffer.from([5]));
  await probeAgentScheme("/fake/agent.sock", agent.requestAgent);
  for (const payload of agent.sent) {
    expect(payload.length).toBe(1); // never a sign body: a truncated sign can only ever FAILURE
    expect([11, 13]).toContain(payload[0]); // only the two candidates' identities bytes
  }
});

test("probeAgentScheme passes the socket path it was given to every candidate", async () => {
  const seen: string[] = [];
  const scheme = await probeAgentScheme("/run/user/1000/agent.sock", async (path, payload) => {
    seen.push(path);
    return payload.equals(Buffer.from([13])) ? EMPTY_ANSWER_14 : Buffer.from([5]);
  });
  expect(scheme).toBe(CLASSIC_SCHEME);
  expect(seen).toEqual(["/run/user/1000/agent.sock"]);
});

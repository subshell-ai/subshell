import { describe, expect, test } from "bun:test";
import {
  parseNodeSshAgentIdentities,
  parseNodeSshAliasList,
  parseNodeSshHostKey,
  parseNodeSshIdentity,
  parseNodeSshResolveOutcome,
} from "../node-results.js";
import { SSH_MAX_HOST_KEY_LINES } from "../ssh-limits.js";
import { makeAliasList, makeResolveOk, makeResolveRefused } from "./fixtures/ssh-fixtures.js";

/** A well-formed public-JWK STRING: the validator's whole job is that it is JSON and an object. */
const SIGNING_JWK =
  '{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}';

describe("parseNodeSshAliasList", () => {
  test("narrows a well-formed answer", () => {
    expect(parseNodeSshAliasList(makeAliasList({ aliases: ["box-a", "box-b"] }))).toEqual({
      aliases: ["box-a", "box-b"],
      includeCycle: false,
      truncated: false,
    });
  });
  test("refuses a past-cap list whole (the truncated flag depends on the cap)", () => {
    expect(
      parseNodeSshAliasList(makeAliasList({ aliases: Array.from({ length: 501 }, (_, i) => `h${i}`) })),
    ).toBeNull();
  });
  test("refuses non-boolean flags and non-string members", () => {
    expect(parseNodeSshAliasList({ aliases: ["x"], includeCycle: "no", truncated: false })).toBeNull();
    expect(parseNodeSshAliasList({ aliases: [1], includeCycle: false, truncated: false })).toBeNull();
  });
});

describe("parseNodeSshResolveOutcome", () => {
  test("accepted arm runs the FULL snapshot validator (no unvalidated snapshot enters the plane)", () => {
    const ok = makeResolveOk();
    expect(parseNodeSshResolveOutcome(ok)).not.toBeNull();
    const tampered = structuredClone(ok);
    (tampered as { snapshot: { host: string } }).snapshot.host = "-oProxyCommand=evil";
    expect(parseNodeSshResolveOutcome(tampered)).toBeNull();
  });
  test("connectingAccount is optional text, never another type", () => {
    expect(parseNodeSshResolveOutcome(makeResolveOk())?.accepted === true).toBe(true);
    const withAccount = structuredClone(makeResolveOk()) as { connectingAccount?: unknown };
    withAccount.connectingAccount = 7;
    expect(parseNodeSshResolveOutcome(withAccount)).toBeNull();
  });
  test("refused arm names a known code and string settings", () => {
    expect(parseNodeSshResolveOutcome(makeResolveRefused())).toEqual({
      accepted: false,
      code: "unsupported_setting",
      settings: ["ProxyCommand"],
    });
    expect(parseNodeSshResolveOutcome({ accepted: false, code: "not_a_code", settings: [] })).toBeNull();
  });
});

describe("parseNodeSshAgentIdentities", () => {
  /** A canonical grant-grammar fingerprint (SHA256: + base64url digest text). */
  const FP_A = `SHA256:${"A".repeat(20)}${"b".repeat(20)}cd`;
  const _FP_B = `SHA256:${"-_9".repeat(14)}x`;

  test("narrows a well-formed roster answer", () => {
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: FP_A, comment: "laptop key" }] })).toEqual({
      identities: [{ fingerprint: FP_A, comment: "laptop key" }],
    });
  });
  test("an EMPTY roster is a legal answer (a live agent may carry zero keys)", () => {
    expect(parseNodeSshAgentIdentities({ identities: [] })).toEqual({ identities: [] });
  });
  test("blob bytes are NOT representable: a wire `blob` member is dropped from the narrowed answer", () => {
    // The grammar has no slot for key material, so even a (buggy or hostile)
    // node that tried to ship one cannot get it past the rebuild.
    const blob = Buffer.from("PRIVATE-WIRE-MATERIAL").toString("base64");
    const parsed = parseNodeSshAgentIdentities({ identities: [{ fingerprint: FP_A, comment: "c", blob }] });
    expect(parsed).toEqual({ identities: [{ fingerprint: FP_A, comment: "c" }] });
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE-WIRE-MATERIAL");
    expect(JSON.stringify(parsed)).not.toContain(blob);
  });
  test("refuses fingerprints outside the canonical SHA256: grammar", () => {
    // The roster's fingerprint must be a valid grant selection, the SAME
    // grammar both directions (the approve error copy promises "exactly as
    // the roster reports it"); anything else is a malformed answer, refused.
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: "MD5:aa:bb", comment: "c" }] })).toBeNull();
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: "SHA256:", comment: "c" }] })).toBeNull();
    expect(
      parseNodeSshAgentIdentities({ identities: [{ fingerprint: "SHA256:with space", comment: "c" }] }),
    ).toBeNull();
    expect(
      parseNodeSshAgentIdentities({ identities: [{ fingerprint: "SHA256:with/slash+plus=", comment: "c" }] }),
    ).toBeNull();
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: 7, comment: "c" }] })).toBeNull();
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: FP_A }] })).toBeNull();
  });
  test("refuses malformed entries, non-string comments, and non-array shapes", () => {
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: FP_A, comment: 4 }] })).toBeNull();
    expect(parseNodeSshAgentIdentities({ identities: [{ fingerprint: FP_A, comment: "x".repeat(254) }] })).toBeNull();
    expect(parseNodeSshAgentIdentities({ identities: "not an array" })).toBeNull();
    expect(parseNodeSshAgentIdentities({ identities: ["bare string"] })).toBeNull();
    expect(parseNodeSshAgentIdentities({})).toBeNull();
    expect(parseNodeSshAgentIdentities(null)).toBeNull();
    expect(parseNodeSshAgentIdentities([])).toBeNull();
  });
});

describe("parseNodeSshIdentity", () => {
  test("narrows a well-formed signing-public-key answer", () => {
    expect(parseNodeSshIdentity({ signingPublicKey: SIGNING_JWK })).toEqual({ signingPublicKey: SIGNING_JWK });
  });
  test("refuses a non-string or empty field", () => {
    expect(parseNodeSshIdentity({ signingPublicKey: 7 })).toBeNull();
    expect(parseNodeSshIdentity({ signingPublicKey: "" })).toBeNull();
    expect(parseNodeSshIdentity({})).toBeNull();
    expect(parseNodeSshIdentity(null)).toBeNull();
    expect(parseNodeSshIdentity(SIGNING_JWK)).toBeNull(); // the answer is an OBJECT, not a bare string
  });
  test("refuses a value that is not well-formed JSON of object shape", () => {
    // The grammar stops at "JSON that parses to an object"; ES256 importability
    // is the server's gate (assertImportableSigningJwk), never this one's.
    expect(parseNodeSshIdentity({ signingPublicKey: "not json at all" })).toBeNull();
    expect(parseNodeSshIdentity({ signingPublicKey: '"a string that parses"' })).toBeNull();
    expect(parseNodeSshIdentity({ signingPublicKey: "[1,2]" })).toBeNull();
    expect(parseNodeSshIdentity({ signingPublicKey: "null" })).toBeNull();
  });
});

describe("parseNodeSshHostKey (spec 2026-10-08 §9, Task 12)", () => {
  const LINE_A = "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000";
  const LINE_B = "|1|bnVsbHNhbHRudWxsc2FsdA==|dGhlaGFzaA==| ssh-ed25519 AAAA";
  test("narrows a well-formed answer of verbatim known_hosts lines", () => {
    expect(parseNodeSshHostKey({ lines: [LINE_A] })).toEqual({ lines: [LINE_A] });
    expect(parseNodeSshHostKey({ lines: [] })).toEqual({ lines: [] }); // the honest "recorded nothing"
  });
  test("rebuilds the lines array (extra answer members do not ride)", () => {
    const parsed = parseNodeSshHostKey({ lines: [LINE_A, LINE_B], sneaky: "x" });
    expect(parsed).not.toHaveProperty("sneaky");
    expect(parsed?.lines).toEqual([LINE_A, LINE_B]);
  });
  test("refuses a malformed or over-cap answer", () => {
    expect(parseNodeSshHostKey({ lines: "not an array" })).toBeNull();
    expect(parseNodeSshHostKey({ lines: [7] })).toBeNull();
    expect(parseNodeSshHostKey({ lines: ["host ssh-rsa AAA\nsecond entry"] })).toBeNull(); // smuggled newline
    expect(parseNodeSshHostKey({ lines: [""] })).toBeNull();
    expect(parseNodeSshHostKey({ lines: null })).toBeNull();
    expect(
      parseNodeSshHostKey({
        lines: Array.from({ length: SSH_MAX_HOST_KEY_LINES + 1 }, (_, i) => `h${i} ssh-ed25519 A`),
      }),
    ).toBeNull();
    expect(
      parseNodeSshHostKey({ lines: Array.from({ length: SSH_MAX_HOST_KEY_LINES }, (_, i) => `h${i} ssh-ed25519 A`) }),
    ).not.toBeNull();
  });
});

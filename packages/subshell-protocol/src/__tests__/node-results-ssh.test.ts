import { describe, expect, test } from "bun:test";
import { parseNodeSshAliasList, parseNodeSshIdentity, parseNodeSshResolveOutcome } from "../node-results.js";
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

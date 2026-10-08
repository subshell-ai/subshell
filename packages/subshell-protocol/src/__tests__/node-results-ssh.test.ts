import { describe, expect, test } from "bun:test";
import { parseNodeSshAliasList, parseNodeSshResolveOutcome } from "../node-results.js";
import { makeAliasList, makeResolveOk, makeResolveRefused } from "./fixtures/ssh-fixtures.js";

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

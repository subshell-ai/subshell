/**
 * The run-at-login switch's version gate, pure (round two, 2026-09-22). The
 * screen's rendering of it — greyed switch, hint sentence — is pinned in
 * `service-screen.test.tsx`; this pins the DECISION, including the numeric
 * compare that a string compare would get backwards.
 */
import { describe, expect, it } from "bun:test";
import { autostartSupported, MIN_AUTOSTART_NODE_VERSION } from "@/lib/autostart-gate";
import { makeProbe } from "./harness";

const withVersion = (version: string | null) => {
  const base = makeProbe();
  return { ...base, nodeBinary: base.nodeBinary ? { ...base.nodeBinary, version } : null };
};

describe("autostartSupported", () => {
  it("names the first agent whose verb can carry the switch", () => {
    expect(MIN_AUTOSTART_NODE_VERSION).toBe("0.15.0");
    expect(autostartSupported(withVersion(MIN_AUTOSTART_NODE_VERSION))).toBe(true);
    expect(autostartSupported(withVersion("0.15.1"))).toBe(true);
    expect(autostartSupported(withVersion("0.14.3"))).toBe(false);
    expect(autostartSupported(withVersion("1.9.0"))).toBe(true);
  });

  it("compares NUMBERS, so 0.9.0 is older than 0.15.0", () => {
    // A string compare sorts "9" above "1" and would refuse the verb on
    // exactly the old agents the gate exists for.
    expect(autostartSupported(withVersion("0.9.0"))).toBe(false);
  });

  it("assumes an unknown version capable, as the server's twin argues", () => {
    // A control disabled by a string this side could not parse is worse than
    // the CLI's own refusal, which arrives with its words.
    expect(autostartSupported(withVersion(null))).toBe(true);
    expect(autostartSupported(undefined)).toBe(true);
  });
});

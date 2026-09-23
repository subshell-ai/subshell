/**
 * The un-enroll card's version gate, pure — the same three pins
 * `autostart-gate.test.ts` carries for its twin, because both gates decide
 * "does the resolved agent have this verb" and both would fail the same way:
 * a string compare sorts "9" over "1", and an over-strict gate on an
 * unparseable version disables a control the CLI would have answered.
 */
import { describe, expect, it } from "bun:test";
import { MIN_UNENROLL_NODE_VERSION, unenrollSupported } from "@/lib/unenroll-gate";
import { makeProbe } from "./harness";

const withVersion = (version: string | null) => {
  const base = makeProbe();
  return { ...base, nodeBinary: base.nodeBinary ? { ...base.nodeBinary, version } : null };
};

describe("unenrollSupported", () => {
  it("names the first agent whose CLI carries `unenroll`", () => {
    expect(MIN_UNENROLL_NODE_VERSION).toBe("0.15.0");
    expect(unenrollSupported(withVersion(MIN_UNENROLL_NODE_VERSION))).toBe(true);
    expect(unenrollSupported(withVersion("0.15.1"))).toBe(true);
    expect(unenrollSupported(withVersion("0.14.3"))).toBe(false);
    expect(unenrollSupported(withVersion("1.9.0"))).toBe(true);
  });

  it("compares NUMBERS, so 0.9.0 is older than 0.15.0", () => {
    expect(unenrollSupported(withVersion("0.9.0"))).toBe(false);
  });

  it("assumes an unknown version capable, as the autostart gate argues", () => {
    expect(unenrollSupported(withVersion(null))).toBe(true);
    expect(unenrollSupported(undefined)).toBe(true);
  });
});

import { describe, expect, it } from "bun:test";
import { maintenanceRefusalNotice, subshellCount } from "@/lib/node-maintenance";

/**
 * The sentence a partly-applied maintenance flip says.
 *
 * The response carries `failed` only when the node refused a kill, so the
 * ABSENT case is the clean one — and it has to stay silent, because the
 * surfaces render this beside a switch that has already moved.
 */
describe("maintenanceRefusalNotice", () => {
  it("says nothing when the node stopped everything", () => {
    expect(maintenanceRefusalNotice("mac mini", undefined)).toBeNull();
    expect(maintenanceRefusalNotice("mac mini", [])).toBeNull();
  });

  it("names the count and keeps both halves of the truth", () => {
    // Either half alone misleads: the refusals alone read as "the switch did
    // not work", the state alone as "everything here is stopped".
    const notice = maintenanceRefusalNotice("mac mini", ["s1", "s2"]);
    expect(notice).toContain("mac mini is in maintenance and will launch nothing");
    expect(notice).toContain("2 subshells could not be stopped");
    expect(notice).toContain("may still be running there");
  });

  it("stays singular at one", () => {
    expect(maintenanceRefusalNotice("shop", ["s1"])).toContain("1 subshell could not be stopped");
  });
});

describe("subshellCount", () => {
  it("is the one spelling every maintenance surface shares", () => {
    expect(subshellCount(0)).toBe("0 subshells");
    expect(subshellCount(1)).toBe("1 subshell");
    expect(subshellCount(4)).toBe("4 subshells");
  });
});

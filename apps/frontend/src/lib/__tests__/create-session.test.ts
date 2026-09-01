import { describe, expect, it } from "bun:test";
import { toSessionCreateBody } from "@/hooks/use-create-session";

describe("toSessionCreateBody", () => {
  it("sends the trimmed name when there is one", () => {
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "  deck  " })).toEqual({
      profileId: "p1",
      workingDir: "/tmp/x",
      name: "deck",
    });
  });

  it("omits the name when blank, so the backend's date/time default applies", () => {
    const body = toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "   " });
    expect(body.name).toBeUndefined();
    expect("name" in body).toBe(true); // the key exists with undefined — JSON.stringify drops it
    expect(JSON.parse(JSON.stringify(body))).toEqual({ profileId: "p1", workingDir: "/tmp/x" });
  });

  it("omits nodeId entirely when the caller carries none (byte-identical legacy body)", () => {
    const body = toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "n" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({ profileId: "p1", workingDir: "/tmp/x", name: "n" });
  });

  it("normalises any picked node to 'local' — the phase-1 belt (spec §3)", () => {
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" }).nodeId).toBe(
      "local",
    );
    // A remote pick is never posted: the backend 409s anything but "local".
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "n1" }).nodeId).toBe("local");
    // And an unmade selection blocks submit upstream (canSubmit), never leaks "".
    expect(toSessionCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" }).nodeId).toBeUndefined();
  });
});

import { describe, expect, it } from "bun:test";
import { lingerFromProbe, lingerProbeArgv, lingerVerdict } from "../linger.js";

describe("lingerProbeArgv", () => {
  it("asks logind by uid, because a username is not always knowable", () => {
    // `os.userInfo()` throws for a uid with no passwd entry, which is the
    // ordinary shape of a container — and the agent's service deps carry no
    // environment seam to read `$USER` from either.
    expect(lingerProbeArgv(1000)).toEqual(["loginctl", "show-user", "1000", "--property=Linger"]);
    expect(lingerProbeArgv(0)).toEqual(["loginctl", "show-user", "0", "--property=Linger"]);
  });
});

describe("lingerFromProbe", () => {
  it("reads logind's own word off a clean exit", () => {
    expect(lingerFromProbe({ code: 0, out: "Linger=yes\n", err: "" })).toBe(true);
    expect(lingerFromProbe({ code: 0, out: "Linger=no\n", err: "" })).toBe(false);
  });

  it("treats `not logged in or lingering` as a measured NO, not an unknown", () => {
    // The case the whole feature turns on. logind holding no record of this
    // user means no session and no linger, and it is the ordinary reply for a
    // service account on a machine nobody signs in to — which is exactly the
    // machine whose answer matters. Calling it unknown would blank the field
    // precisely where it is most useful.
    const res = { code: 1, out: "", err: "Failed to get user: User ID 1000 is not logged in or lingering\n" };
    expect(lingerFromProbe(res)).toBe(false);
    // Either stream, since which one carries it is not ours to depend on.
    expect(lingerFromProbe({ code: 1, out: res.err, err: "" })).toBe(false);
  });

  it("answers null when nothing reached logind at all", () => {
    // No `loginctl` on PATH, or no bus to connect to. Never `false`: that
    // would be a fact nobody measured, and it has a remedy attached to it.
    expect(lingerFromProbe({ code: 127, out: "", err: "loginctl: command not found\n" })).toBeNull();
    expect(lingerFromProbe({ code: 1, out: "", err: "Failed to connect to bus: No such file or directory\n" })).toBe(
      null,
    );
  });

  it("answers null for a clean exit that never mentions Linger", () => {
    expect(lingerFromProbe({ code: 0, out: "", err: "" })).toBeNull();
    expect(lingerFromProbe({ code: 0, out: "UID=1000\nGID=1000\n", err: "" })).toBeNull();
    // A value logind has never emitted is still not a yes.
    expect(lingerFromProbe({ code: 0, out: "Linger=maybe\n", err: "" })).toBeNull();
  });

  it("finds the property among its neighbours, wherever it sits", () => {
    expect(lingerFromProbe({ code: 0, out: "UID=1000\nLinger=yes\nState=active\n", err: "" })).toBe(true);
    // A property whose NAME merely ends in Linger is a different property.
    expect(lingerFromProbe({ code: 0, out: "NotLinger=yes\n", err: "" })).toBeNull();
  });
});

describe("lingerVerdict", () => {
  it("names the remedy rather than only the problem", () => {
    // The reader is already at a shell on that machine, and the fix is one
    // command, so withholding it would be withholding the useful half.
    expect(lingerVerdict(false)).toContain("loginctl enable-linger $USER");
  });

  it("blames nothing when the answer could not be established", () => {
    // `null` covers two causes — logind refusing to answer, and a probe that
    // never ran because the service manager had already failed — so naming a
    // tool here would send someone to debug the wrong one.
    expect(lingerVerdict(null)).toBe("unknown (could not be measured)");
    expect(lingerVerdict(null)).not.toContain("loginctl");
  });

  it("states the settled case without offering anything to do", () => {
    expect(lingerVerdict(true)).toBe("yes (user lingers)");
    expect(lingerVerdict(true)).not.toContain("loginctl");
  });
});

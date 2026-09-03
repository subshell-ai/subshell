import { describe, expect, it } from "bun:test";
import { toSubshellCreateBody } from "@/hooks/use-create-subshell";

describe("toSubshellCreateBody", () => {
  it("sends the trimmed name when there is one", () => {
    expect(toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "  deck  " })).toEqual({
      profileId: "p1",
      workingDir: "/tmp/x",
      name: "deck",
    });
  });

  it("omits the name when blank, so the backend's date/time default applies", () => {
    const body = toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "   " });
    expect(body.name).toBeUndefined();
    expect("name" in body).toBe(true); // the key exists with undefined — JSON.stringify drops it
    expect(JSON.parse(JSON.stringify(body))).toEqual({ profileId: "p1", workingDir: "/tmp/x" });
  });

  it("omits nodeId entirely when the caller carries none (byte-identical legacy body)", () => {
    const body = toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "n" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({ profileId: "p1", workingDir: "/tmp/x", name: "n" });
  });

  it("posts a remote pick as-is — remote launch is real (spec §6.6)", () => {
    // The form's node choice reaches the server verbatim; the backend
    // resolves/gates it (404 invisible, 409 NODE_OFFLINE).
    expect(toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "n1" }).nodeId).toBe("n1");
    const body = toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "n", nodeId: "mac-mini" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      profileId: "p1",
      workingDir: "/tmp/x",
      name: "n",
      nodeId: "mac-mini",
    });
  });

  it("sends 'local' explicitly — the visible pick is the launch target (spec 2026-09-02 §3)", () => {
    const body = toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "n", nodeId: "local" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      profileId: "p1",
      workingDir: "/tmp/x",
      name: "n",
      nodeId: "local",
    });
  });

  it("omits nodeId only for an absent/unmade pick", () => {
    // An unmade selection blocks submit upstream (canSubmit), never leaks "".
    expect(toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "" }).nodeId).toBeUndefined();
    expect(
      toSubshellCreateBody({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" }).nodeId,
    ).toBeUndefined();
  });
});

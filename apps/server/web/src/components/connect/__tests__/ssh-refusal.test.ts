import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@internal/node-admin";
import { isSshResolveRefusal, type SshMachineFacts, sshLaunchRefusal } from "@/components/connect/ssh-refusal";

/**
 * The refusal matrix of `POST /api/ssh/launch` (launch.route.ts's response
 * map), each branch named (Task 3 addition 1). The 422 is the branch with
 * two roads: a parsed `{outcome}` body renders the blocked settings verbatim
 * even when the display message was sliced to 200 chars, and an old or
 * body-less 422 falls back to the message text rather than inventing one.
 */
const machine = (over: Partial<SshMachineFacts>): SshMachineFacts => ({
  name: "mac mini",
  kind: "agent",
  sshEnabled: true,
  ...over,
});

describe("sshLaunchRefusal", () => {
  it("422 with a body renders every blocked setting verbatim, sliced message or not", () => {
    const settings = ["ProxyCommand", "LocalForward", "RemoteForward"];
    const raw = JSON.stringify({ outcome: { accepted: false, code: "unsupported_setting", settings } });
    const err = new ApiError(422, raw.slice(0, 200), { body: JSON.parse(raw) });
    const copy = sshLaunchRefusal(err, machine({}));
    expect(copy).toEqual({
      text: "Config needs settings Subshell does not run: ProxyCommand, LocalForward, RemoteForward. Edit them on the connecting machine and retry.",
      field: "destination",
    });
  });

  it("422 whose code names the whole cause (no settings) says so without an empty list", () => {
    const err = new ApiError(422, "", { body: { outcome: { accepted: false, code: "config_missing", settings: [] } } });
    const copy = sshLaunchRefusal(err, machine({}));
    expect(copy?.text).toBe(
      "Subshell cannot run this destination as its config stands. Edit that config on the connecting machine and retry.",
    );
    expect(copy?.field).toBe("destination");
  });

  it("422 with no parseable body falls back to the message text", () => {
    const err = new ApiError(422, "refused"); // no body: an old server or a proxy page
    expect(sshLaunchRefusal(err, machine({}))).toEqual({ text: "API 422: refused", field: "destination" });
  });

  it("400 names the destination as invalid, not the machine", () => {
    expect(sshLaunchRefusal(new ApiError(400, "x", { code: "ALIAS_UNSAFE" }), machine({}))).toEqual({
      text: "That destination is not a valid name to connect to.",
      field: "destination",
    });
  });

  it("403 SSH_GATE_OFF on a gated-off agent names the owner remedy", () => {
    expect(sshLaunchRefusal(new ApiError(403, "x", { code: "SSH_GATE_OFF" }), machine({ sshEnabled: false }))).toEqual({
      text: "SSH is off on this machine. Ask its owner to enable it.",
      field: "machine",
    });
  });

  it("403 SSH_GATE_OFF on the control-plane host names the admin remedy", () => {
    const local = machine({ kind: "local", name: "this host", sshEnabled: false });
    expect(sshLaunchRefusal(new ApiError(403, "x", { code: "SSH_GATE_OFF" }), local)).toEqual({
      text: "An admin can enable SSH on this machine in its settings.",
      field: "machine",
    });
  });

  it("403 with the gate ON is the owner-door: no share reaches SSH", () => {
    expect(sshLaunchRefusal(new ApiError(403, "x", { code: "SSH_GATE_OFF" }), machine({}))).toEqual({
      text: "You can't connect from this machine.",
      field: "machine",
    });
  });

  it("404 says the machine isn't available", () => {
    expect(sshLaunchRefusal(new ApiError(404, "x", { code: "NOT_FOUND_ERROR" }), machine({}))).toEqual({
      text: "That machine isn't available.",
      field: "machine",
    });
  });

  it("409 arms name the machine and their own cause", () => {
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_OFFLINE" }), machine({}))?.text).toBe(
      "mac mini has no live connection right now. Bring its Subshell app online and retry.",
    );
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_PROTOCOL_HELD" }), machine({}))?.text).toBe(
      "mac mini runs a Subshell version this server does not speak. Update it from its machine page and retry.",
    );
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_OUTDATED" }), machine({}))?.text).toBe(
      "The Subshell app on mac mini is too old to speak SSH. Update it from its machine page.",
    );
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_UNREACHABLE" }), machine({}))?.text).toBe(
      "mac mini did not answer the SSH request in time. Check its connection and retry.",
    );
    // No machine facts (the row vanished) keeps the sentence grammatical.
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_OFFLINE" }), null)?.text).toBe(
      "That machine has no live connection right now. Bring its Subshell app online and retry.",
    );
  });

  it("409 NODE_IN_MAINTENANCE names maintenance, not the missing connection", () => {
    // The create under the ssh launch throws this code when the machine is in
    // a window (`rethrowLaunchRefusal`, subshells.service.ts) - a live link
    // exists, it just takes no new panes, so the offline sentence would lie.
    const copy = sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_IN_MAINTENANCE" }), machine({}));
    expect(copy?.text).toBe(
      "mac mini is in maintenance and takes no new panes. Wait for it to come out of maintenance.",
    );
    expect(copy?.text).not.toContain("no live connection");
    // The vanish-the-row fallback stays grammatical too.
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_IN_MAINTENANCE" }), null)?.text).toBe(
      "That machine is in maintenance and takes no new panes. Wait for it to come out of maintenance.",
    );
  });

  it("502 is the machine's own refusal, with the checks that answer it", () => {
    expect(sshLaunchRefusal(new ApiError(502, "x", { code: "SSH_NODE_REFUSED" }), machine({}))).toEqual({
      text: "The connecting machine refused the SSH request. Check that SSH is switched on there and that ssh is installed.",
      field: "machine",
    });
  });

  it("a NetworkError renders nothing: the global offline banner already says it", () => {
    expect(sshLaunchRefusal(new NetworkError(new TypeError("down")), machine({}))).toBeNull();
  });

  it("an unexpected failure gets the generic red line, never an API string", () => {
    expect(sshLaunchRefusal(new Error("boom"), machine({}))?.text).toBe("The connection could not be started.");
    expect(sshLaunchRefusal(new ApiError(500, "Internal"), machine({}))?.text).toBe(
      "The connection could not be started.",
    );
  });

  it("every shipped sentence is at most two sentences and dash-free", () => {
    // Named codes too, so the per-branch arms are all in the sweep, not just
    // the default ones.
    const cases: [number, string][] = [
      [422, "ANY"],
      [400, "ALIAS_UNSAFE"],
      [403, "SSH_GATE_OFF"],
      [404, "NOT_FOUND_ERROR"],
      [409, "NODE_IN_MAINTENANCE"],
      [409, "NODE_PROTOCOL_HELD"],
      [409, "NODE_OUTDATED"],
      [409, "NODE_UNREACHABLE"],
      [409, "NODE_OFFLINE"],
      [409, "ANY"],
      [502, "SSH_NODE_REFUSED"],
    ];
    const texts = cases.flatMap(([status, code]) => {
      const copy = sshLaunchRefusal(new ApiError(status, "x", { code }), machine({ sshEnabled: false }));
      return copy === null ? [] : [copy.text];
    });
    for (const text of texts) {
      expect(text).not.toMatch(/[─—–]/); // U+2500, U+2014, U+2013
      expect(text.split(/[.!?] /).length).toBeLessThanOrEqual(2);
    }
  });

  it("isSshResolveRefusal narrows the refused arm only", () => {
    expect(isSshResolveRefusal({ accepted: false, code: "config_missing", settings: [] })).toBe(true);
    expect(isSshResolveRefusal({ accepted: true, snapshot: {} })).toBe(false);
    expect(isSshResolveRefusal({ accepted: false, code: "x" })).toBe(false); // no settings array
    expect(isSshResolveRefusal(null)).toBe(false);
    expect(isSshResolveRefusal("outcome")).toBe(false);
  });
});

for (const field of ["metadata", "metadataSafe"]) {
  it(`preserves the approval request ID from ${field}`, () => {
    const err = new ApiError(409, "Approval", {
      code: "SSH_GRANT_APPROVAL_REQUIRED",
      body: { [field]: { requestId: "req1" } },
    });
    expect(sshLaunchRefusal(err, null)?.requestId).toBe("req1");
  });
}

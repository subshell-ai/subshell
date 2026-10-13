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
  it("destination identity refusals preserve the complete user message without the API prefix", () => {
    const message =
      "The destination’s identity has changed, so Subshell blocked the connection. Ask its administrator to verify the change before trying again.";
    const err = new ApiError(409, message, { code: "SSH_HOST_PIN_CHANGED", body: { message } });
    expect(sshLaunchRefusal(err, machine({}))).toEqual({ field: "destination", text: message });
  });
  it("422 with a body renders every blocked setting verbatim, sliced message or not", () => {
    const settings = ["ProxyCommand", "LocalForward", "RemoteForward"];
    const raw = JSON.stringify({ outcome: { accepted: false, code: "unsupported_setting", settings } });
    const err = new ApiError(422, raw.slice(0, 200), { body: JSON.parse(raw) });
    const copy = sshLaunchRefusal(err, machine({}));
    expect(copy).toEqual({
      text: "This SSH configuration uses settings Subshell doesn't support: ProxyCommand, LocalForward, RemoteForward. Update them on the connecting machine and try again.",
      field: "destination",
    });
  });

  it("422 whose code names the whole cause (no settings) says so without an empty list", () => {
    const err = new ApiError(422, "", { body: { outcome: { accepted: false, code: "config_missing", settings: [] } } });
    const copy = sshLaunchRefusal(err, machine({}));
    expect(copy?.text).toBe(
      "Subshell can't connect using this SSH configuration. Update it on the connecting machine and try again.",
    );
    expect(copy?.field).toBe("destination");
  });

  it("422 with no parseable body falls back to the message text", () => {
    const err = new ApiError(422, "refused"); // no body: an old server or a proxy page
    expect(sshLaunchRefusal(err, machine({}))).toEqual({ text: "API 422: refused", field: "destination" });
  });

  it("400 names the destination as invalid, not the machine", () => {
    expect(sshLaunchRefusal(new ApiError(400, "x", { code: "ALIAS_UNSAFE" }), machine({}))).toEqual({
      text: "Enter a valid SSH destination, such as deploy@example.com:22.",
      field: "destination",
    });
  });

  it("403 SSH_GATE_OFF on a gated-off agent names the owner remedy", () => {
    expect(sshLaunchRefusal(new ApiError(403, "x", { code: "SSH_GATE_OFF" }), machine({ sshEnabled: false }))).toEqual({
      text: "Outgoing SSH is disabled on this node. Ask this node’s owner to enable it.",
      field: "machine",
    });
  });

  it("403 SSH_GATE_OFF on the control-plane host names the admin remedy", () => {
    const local = machine({ kind: "local", name: "this host", sshEnabled: false });
    expect(sshLaunchRefusal(new ApiError(403, "x", { code: "SSH_GATE_OFF" }), local)).toEqual({
      text: "Outgoing SSH is disabled on this node. An admin can enable it in this node’s settings.",
      field: "machine",
    });
  });

  it("403 with SSH enabled does not guess which access rule blocked the request", () => {
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
      "mac mini is offline. Start its Subshell daemon and try again.",
    );
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_PROTOCOL_HELD" }), machine({}))?.text).toBe(
      "mac mini runs a Subshell version this server doesn't support. Update it from its node page and try again.",
    );
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_OUTDATED" }), machine({}))?.text).toBe(
      "Update Subshell on mac mini from its node page to use SSH.",
    );
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_UNREACHABLE" }), machine({}))?.text).toBe(
      "mac mini didn't answer the SSH request in time. Check its connection and try again.",
    );
    // No machine facts (the row vanished) keeps the sentence grammatical.
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_OFFLINE" }), null)?.text).toBe(
      "That machine is offline. Start its Subshell daemon and try again.",
    );
  });

  it("409 NODE_IN_MAINTENANCE names maintenance, not the missing connection", () => {
    // The create under the ssh launch throws this code when the machine is in
    // a window (`rethrowLaunchRefusal`, subshells.service.ts) - a live link
    // exists, it just takes no new panes, so the offline sentence would lie.
    const copy = sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_IN_MAINTENANCE" }), machine({}));
    expect(copy?.text).toBe(
      "mac mini is in maintenance, so you can't start new subshells on it. Try again when maintenance ends.",
    );
    expect(copy?.text).not.toContain("no live connection");
    // The vanish-the-row fallback stays grammatical too.
    expect(sshLaunchRefusal(new ApiError(409, "x", { code: "NODE_IN_MAINTENANCE" }), null)?.text).toBe(
      "That machine is in maintenance, so you can't start new subshells on it. Try again when maintenance ends.",
    );
  });

  it("502 is the machine's own refusal, with the checks that answer it", () => {
    expect(sshLaunchRefusal(new ApiError(502, "x", { code: "SSH_NODE_REFUSED" }), machine({}))).toEqual({
      text: "This machine couldn’t start SSH. Check that outgoing SSH is enabled on this node and that the ssh command is installed.",
      field: "machine",
    });
  });

  it("a NetworkError renders nothing: the global offline banner already says it", () => {
    expect(sshLaunchRefusal(new NetworkError(new TypeError("down")), machine({}))).toBeNull();
  });

  it("an unexpected failure gets the generic red line, never an API string", () => {
    expect(sshLaunchRefusal(new Error("boom"), machine({}))?.text).toBe("Couldn't start the SSH connection.");
    expect(sshLaunchRefusal(new ApiError(500, "Internal"), machine({}))?.text).toBe(
      "Couldn't start the SSH connection.",
    );
  });

  it("refusal copy uses ordinary punctuation", () => {
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

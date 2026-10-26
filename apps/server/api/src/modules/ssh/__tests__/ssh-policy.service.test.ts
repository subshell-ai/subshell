import { describe, expect, test } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import type { NodeGate } from "@/modules/nodes/gate.js";
import { blockersRevokeAccess, sshPolicy } from "@/modules/ssh/policy.js";
import { selectRelayFingerprints } from "@/modules/ssh/ssh-relay-launch.service.js";

const ready = { lockdown: false, serverAccountEnabled: true, held: false, online: true, ready: true };
const gate = (over: Partial<NodeGate> = {}): NodeGate => ({
  row: { id: "agent", kind: "agent", sshEnabled: 1, maintenance: 0 } as NodeGate["row"],
  access: "view",
  granted: "view",
  isAdmin: false,
  shares: [],
  canManage: false,
  canRetire: false,
  ...over,
});

describe("SSH policy follows existing launch permission", () => {
  test("view and edit launch shares connect without gaining SSH configuration rights", () => {
    for (const access of ["view", "edit"] as const) {
      expect(sshPolicy(gate({ access, granted: access }), ready)).toEqual({
        canConnect: true,
        canConfigure: false,
        blockers: [],
      });
    }
  });
  test("owner and local admin configuration rights survive blocked runtime", () => {
    expect(sshPolicy(gate({ canManage: true }), { ...ready, online: false }).canConfigure).toBe(true);
  });
  test("local admin boost does not substitute for launch shares", () => {
    const local = gate({
      row: { kind: "local", sshEnabled: 1, maintenance: 0 } as NodeGate["row"],
      access: "edit",
      granted: "none",
      isAdmin: true,
      canManage: true,
    });
    expect(sshPolicy(local, ready).canConnect).toBe(false);
    expect(sshPolicy({ ...local, granted: "view" }, ready).canConnect).toBe(true);
    expect(sshPolicy({ ...local, granted: "view" }, { ...ready, serverAccountEnabled: false }).canConnect).toBe(false);
  });
  test.each([
    [{ ...ready, lockdown: true }, BackendErrorCodes.SSH_GATE_OFF],
    [{ ...ready, held: true }, BackendErrorCodes.NODE_PROTOCOL_HELD],
    [{ ...ready, online: false }, BackendErrorCodes.NODE_OFFLINE],
    [{ ...ready, ready: false }, BackendErrorCodes.NODE_OFFLINE],
  ])("runtime and global launch blockers are structured", (state, code) => {
    const result = sshPolicy(gate(), state);
    expect(result.canConnect).toBe(false);
    expect(result.blockers[0]?.code).toBe(code);
    expect(result.blockers[0]?.message.length).toBeGreaterThan(10);
  });
  test("maintenance and disabled SSH refuse even owners", () => {
    const owner = gate({ access: "owner", granted: "owner", canManage: true });
    expect(sshPolicy({ ...owner, row: { ...owner.row, maintenance: 1 } }, ready).blockers[0]?.code).toBe(
      BackendErrorCodes.NODE_IN_MAINTENANCE,
    );
    expect(sshPolicy({ ...owner, row: { ...owner.row, sshEnabled: 0 } }, ready).canConnect).toBe(false);
  });
});

describe("access revocation excludes maintenance", () => {
  test("a maintenance-only row is not an authorization loss", () => {
    // This is the exact blocker set `sshAccessRevoked` sees when the neutralized
    // state clears lockdown/liveness but the row still carries maintenance=1:
    // a key-home machine in maintenance must NOT cut a live relay on the other
    // node, so it cannot read as a revocation.
    const maintOnly = [{ code: BackendErrorCodes.NODE_IN_MAINTENANCE, message: "in maintenance" }];
    expect(blockersRevokeAccess(maintOnly)).toBe(false);
  });
  test("a genuine authorization loss revokes even alongside maintenance", () => {
    expect(blockersRevokeAccess([{ code: BackendErrorCodes.SSH_GATE_OFF, message: "ssh off" }])).toBe(true);
    expect(
      blockersRevokeAccess([
        { code: BackendErrorCodes.NODE_IN_MAINTENANCE, message: "in maintenance" },
        { code: BackendErrorCodes.SSH_GATE_OFF, message: "launch access gone" },
      ]),
    ).toBe(true);
  });
  test("no blockers means still authorized", () => {
    expect(blockersRevokeAccess([])).toBe(false);
  });
});

describe("SSH relay key selection", () => {
  const roster = Array.from({ length: 9 }, (_, i) => ({ fingerprint: `SHA256:${`key${i}`.padEnd(43, "0")}` }));
  test("omitted selection uses the whole current roster within the cap", () => {
    expect(selectRelayFingerprints(roster.slice(0, 8))).toEqual({
      ok: true,
      value: roster.slice(0, 8).map((k) => k.fingerprint),
    });
    const result = selectRelayFingerprints(roster);
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.status !== 422)
      expect(result.refusal.code).toBe(BackendErrorCodes.SSH_KEYS_OVER_LIMIT);
  });
  test("explicit choice is deduplicated and must belong to the live roster", () => {
    const fp1 = `SHA256:${`key1`.padEnd(43, "0")}`;
    expect(selectRelayFingerprints(roster, [fp1, fp1])).toEqual({
      ok: true,
      value: [fp1],
    });
    expect(selectRelayFingerprints(roster, [`SHA256:${"m".repeat(43)}`]).ok).toBe(false);
    expect(selectRelayFingerprints(roster, ["not-a-fingerprint"]).ok).toBe(false);
    expect(selectRelayFingerprints(roster, null as unknown as string[]).ok).toBe(false);
  });
});

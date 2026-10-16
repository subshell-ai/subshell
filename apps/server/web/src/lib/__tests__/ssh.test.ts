import { describe, expect, it } from "bun:test";
import { SSH_MAX_SELECTED_FINGERPRINTS } from "@internal/subshell-protocol";
import { type SshMachineReadiness, sshMachineRowReason, sshSelectionError } from "@/lib/ssh";

/**
 * The client-side half of the grant selection rule (spec 2026-10-08 §5.4,
 * §6.2). The server refuses an over-cap selection as a HARD error, never a
 * truncation; the screen shows the same sentence before the POST so a person
 * learns the cap from a red line, not from a lost click. The tests pin the
 * boundary at SSH_MAX_SELECTED_FINGERPRINTS itself: at the cap is legal.
 */
describe("sshSelectionError (the over-cap hard error)", () => {
  const fp = (i: number) => `SHA256:${"A".repeat(40)}${i}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => fp(i));

  it("accepts a selection at the cap", () => {
    expect(sshSelectionError(many(SSH_MAX_SELECTED_FINGERPRINTS))).toBeNull();
  });

  it("accepts an empty selection (an empty set is legal, it serves nothing)", () => {
    expect(sshSelectionError([])).toBeNull();
  });

  it("names the cap once the selection exceeds it", () => {
    const error = sshSelectionError(many(SSH_MAX_SELECTED_FINGERPRINTS + 1));
    expect(error).toContain(String(SSH_MAX_SELECTED_FINGERPRINTS));
  });
});

/**
 * The one-line explanation an unlaunchable machine wears in the launch
 * pickers (ruling 2026-10-16): gold and short when the machine's own SSH
 * switch is the sole refusal, the server's full remedy sentences otherwise
 * (naming only the switch when something ELSE also blocks would mislead).
 */
describe("sshMachineRowReason", () => {
  const machine = (overrides: {
    sshEnabled: boolean;
    blockers: { code: string; message: string }[];
  }): SshMachineReadiness =>
    ({
      node: { id: "n1", name: "box", sshEnabled: overrides.sshEnabled },
      canConnect: overrides.blockers.length === 0,
      canConfigure: true,
      blockers: overrides.blockers,
    }) as unknown as SshMachineReadiness;

  const gateOff = { code: "SSH_GATE_OFF", message: "Outgoing SSH is disabled on this node. Ask its owner." };

  it("says nothing for a machine with no blockers", () => {
    expect(sshMachineRowReason(machine({ sshEnabled: true, blockers: [] }))).toBeUndefined();
  });

  it("shortens to gold when the switch is the sole refusal", () => {
    expect(sshMachineRowReason(machine({ sshEnabled: false, blockers: [gateOff] }))).toEqual({
      reason: "SSH not enabled",
      warning: true,
    });
  });

  it("keeps the server's sentences when something else blocks too", () => {
    const also = { code: "NODE_OFFLINE", message: "Start Subshell on this machine to bring it online." };
    const row = sshMachineRowReason(machine({ sshEnabled: false, blockers: [gateOff, also] }));
    expect(row).toEqual({ reason: `${gateOff.message} ${also.message}`, warning: false });
  });

  it("keeps the sentence when SSH_GATE_OFF is not the machine's switch (the server gate, lockdown)", () => {
    const row = sshMachineRowReason(machine({ sshEnabled: true, blockers: [gateOff] }));
    expect(row).toEqual({ reason: gateOff.message, warning: false });
  });
});

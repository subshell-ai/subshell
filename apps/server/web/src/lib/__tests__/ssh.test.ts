import { describe, expect, it } from "bun:test";
import { SSH_MAX_SELECTED_FINGERPRINTS } from "@internal/subshell-protocol";
import { sshSelectionError } from "@/lib/ssh";

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

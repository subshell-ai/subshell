import { describe, expect, it } from "bun:test";
import type { SubshellUpdate } from "@/db/types/subshells.db-types.js";
import { type PaneInputRow, paneInputAllowed } from "@/lib/ssh-pane-access.js";

/**
 * `paneInputAllowed` is the ONE ssh input predicate (spec 2026-10-07 §5.4,
 * plan decision 5). The GRANT half (edit/view, the bearer switch-off) lives
 * in `#gate` and the attach resolver as always; this composes with them.
 *
 * Compile-time pin in the last block: `SubshellUpdate` must NOT carry `ssh`,
 * evaluated by `verify-types` (bun test strips types and runs the assignment
 * harmlessly). The `@ts-expect-error` fails the build the moment `ssh`
 * reappears in the patch shape, which is the drift being bounded: the
 * snapshot is written exactly once, by the create path, like the
 * `crossAgent` exclusion it mirrors.
 */

const OWNER = "u-owner";
const STRANGER = "u-stranger";

const ordinary: PaneInputRow = { ssh: null, userId: OWNER };
const sshRow: PaneInputRow = { ssh: '{"destination":"host.example"}', userId: OWNER };

describe("paneInputAllowed (spec §5.4, decision 5)", () => {
  it("admits every actor on an ordinary pane (the grant gate is not this predicate's question)", () => {
    // The regression direction: for ssh === null the predicate is true for
    // everyone, so every existing door behaves exactly as it did before.
    expect(paneInputAllowed(ordinary, OWNER, false)).toBe(true); // owner, cookie
    expect(paneInputAllowed(ordinary, STRANGER, false)).toBe(true); // a grantee, cookie
    expect(paneInputAllowed(ordinary, OWNER, true)).toBe(true); // the pane's own key (bearer)
    expect(paneInputAllowed(ordinary, STRANGER, true)).toBe(true); // a bearer resolving as another owner
  });

  it("admits the owner's human account on an ssh pane", () => {
    expect(paneInputAllowed(sshRow, OWNER, false)).toBe(true);
  });

  it("refuses any other account on an ssh pane, however they got past the grant gate", () => {
    // An `edit` grantee passes the grant gate; the kind rule still refuses.
    expect(paneInputAllowed(sshRow, STRANGER, false)).toBe(false);
  });

  it("refuses a bearer machine credential on an ssh pane, EVEN one resolving as the owner", () => {
    // The whole point of the `bearerActor` input: raw REST resolves a pane's
    // own subshell key as its OWNER (boost/shares off), so a bare owner
    // comparison would let an ssh pane type into itself (decision 5).
    expect(paneInputAllowed(sshRow, OWNER, true)).toBe(false);
    expect(paneInputAllowed(sshRow, STRANGER, true)).toBe(false);
  });

  it("is decided by the column's presence, not its content", () => {
    // The kind fact is "the column is not NULL". Any non-null content is an
    // ssh pane (minimal, or otherwise odd): the SAME owner/non-owner split
    // holds whatever the bytes are, because snapshot validation belongs to
    // the launch boundary, not the input door.
    for (const ssh of ['{"destination":"host.example"}', "{}", "not-json"]) {
      expect(paneInputAllowed({ ssh, userId: OWNER }, OWNER, false)).toBe(true);
      expect(paneInputAllowed({ ssh, userId: OWNER }, STRANGER, false)).toBe(false);
    }
    // Only NULL reads as an ordinary pane.
    expect(paneInputAllowed({ ssh: null, userId: OWNER }, STRANGER, false)).toBe(true);
  });
});

describe("SubshellUpdate excludes ssh (frozen at create, like crossAgent)", () => {
  it("a patch naming `ssh` is a type error (pinned by verify-types)", () => {
    const patch: SubshellUpdate = {};
    // @ts-expect-error `ssh` is excluded from the update-patch shape
    patch.ssh = '{"destination":"host.example"}';
    void patch;
  });
});

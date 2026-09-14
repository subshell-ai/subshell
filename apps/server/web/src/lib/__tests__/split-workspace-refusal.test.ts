import { describe, expect, it } from "bun:test";
import { splitWorkspaceRefusal } from "@/lib/split-workspace-refusal";

describe("splitWorkspaceRefusal", () => {
  it("accepts the response a current server gives: an unsaved workspace holding the subshell", () => {
    expect(splitWorkspaceRefusal({ draft: true, subshellCount: 1 })).toBeNull();
  });

  // The failure this exists for, observed on 2026-09-14: a dev SPA talking to
  // a server binary built before drafts existed. Elysia drops body fields its
  // schema does not declare, so the create SUCCEEDS and silently ignores both
  // `draft` and `subshellId` — the split then lands on a workspace missing the
  // subshell it was split from.
  it("refuses a response that dropped the subshell", () => {
    expect(splitWorkspaceRefusal({ draft: true, subshellCount: 0 })).toMatch(/older build/);
  });

  it("refuses a response that dropped the draft flag", () => {
    expect(splitWorkspaceRefusal({ draft: false, subshellCount: 1 })).toMatch(/older build/);
  });

  it("refuses a response missing the fields altogether", () => {
    expect(splitWorkspaceRefusal({})).toMatch(/older build/);
  });

  it("refuses more panes than were asked for, rather than assuming the extra is harmless", () => {
    expect(splitWorkspaceRefusal({ draft: true, subshellCount: 2 })).toMatch(/older build/);
  });
});

import { describe, expect, it } from "bun:test";
import { ApiError } from "@internal/node-admin";
import { splitCreateFailureMessage, splitWorkspaceRefusal } from "@/lib/split-workspace-refusal";

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

describe("splitCreateFailureMessage", () => {
  // A current server puts drafts OUTSIDE the unique-name index, so a split
  // cannot collide with a name at all. A 409 here therefore says nothing
  // about names and everything about the build on the other end — which is
  // exactly what the person hit on 2026-09-14, reading "You already have a
  // workspace with that name" about a name they never typed.
  it("reads a 409 as the server being behind, not as a name clash", () => {
    expect(splitCreateFailureMessage(new ApiError(409, "You already have a workspace with that name"))).toMatch(
      /older build/,
    );
  });

  it("passes any other API failure through in the server's own words", () => {
    expect(splitCreateFailureMessage(new ApiError(500, "Database is locked"))).toBe("API 500: Database is locked");
  });

  it("falls back for a failure that carries no message", () => {
    expect(splitCreateFailureMessage(new Error(""))).toMatch(/could not create/i);
  });
});

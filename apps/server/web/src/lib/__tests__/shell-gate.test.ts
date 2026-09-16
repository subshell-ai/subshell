import { describe, expect, it } from "bun:test";
import { shellGate } from "@/lib/shell-gate";

const base = {
  isLoading: false,
  hasUser: false,
  offline: false,
  setupLoading: false,
  needsSetup: false as boolean | undefined,
  bare: false,
  pathname: "/",
  // Spec 2026-09-16: the wizard's resume bookmark. Both default to "a signed-in
  // user with no wizard in progress, fully read", which is what every
  // pre-existing case was implicitly about.
  progressLoading: false,
  resumeSetup: false,
};

describe("shellGate", () => {
  it("holds a blank first paint while the subshell is still loading (server up)", () => {
    expect(shellGate({ ...base, isLoading: true })).toBe("blank");
  });

  // Regression #7: cold start against a down server must not be a ~15-min blank.
  it("paints the offline notice during a cold-start outage instead of nothing", () => {
    expect(shellGate({ ...base, isLoading: true, offline: true })).toBe("offlineHold");
  });

  // Regression #8: an outage is not a sign-out.
  it("never bounces to /login while offline", () => {
    expect(shellGate({ ...base, offline: true })).toBe("render");
  });

  it("bounces a definitively signed-out visitor to /login off bare pages", () => {
    expect(shellGate(base)).toBe("toLogin");
    expect(shellGate({ ...base, bare: true })).toBe("render"); // /login renders itself
  });

  it("sends a first-run instance to /setup, even from a bare page check", () => {
    expect(shellGate({ ...base, needsSetup: true })).toBe("toSetup");
    expect(shellGate({ ...base, needsSetup: true, pathname: "/setup", bare: true })).toBe("render");
  });

  it("holds while the setup state is still resolving on a guarded page", () => {
    expect(shellGate({ ...base, setupLoading: true })).toBe("holdSetup");
    // Bare pages own their frame and never wait on setup state (the guard
    // needs it only to choose the redirect target).
    expect(shellGate({ ...base, setupLoading: true, bare: true })).toBe("render");
  });

  it("renders the frame for a signed-in user, outage or not", () => {
    expect(shellGate({ ...base, hasUser: true })).toBe("render");
    expect(shellGate({ ...base, hasUser: true, offline: true })).toBe("render");
  });
});

/**
 * The wizard resume (spec 2026-09-16 § 2.4): a signed-in user whose bookmark
 * names a step is kept ON /setup, and first paint holds until the bookmark
 * has answered — the two rules that replace "the wizard's step lived only in
 * React state".
 */
describe("shellGate: the wizard bookmark", () => {
  it("sends a signed-in user with a bookmark back to /setup", () => {
    expect(shellGate({ ...base, hasUser: true, resumeSetup: true })).toBe("toSetup");
  });

  it("renders /setup itself for a bookmarked user, rather than redirecting in place", () => {
    expect(shellGate({ ...base, hasUser: true, resumeSetup: true, pathname: "/setup", bare: true })).toBe("render");
  });

  it("holds first paint while a signed-in user's bookmark is still loading", () => {
    expect(shellGate({ ...base, hasUser: true, progressLoading: true })).toBe("blank");
  });

  it("leaves a signed-in user with NO bookmark at every existing outcome", () => {
    // The regression this pins: a completed setup must not become a loop.
    expect(shellGate({ ...base, hasUser: true, resumeSetup: false, progressLoading: false })).toBe("render");
    expect(shellGate({ ...base, hasUser: true, progressLoading: true, offline: true })).toBe("render");
    // Offline: the hold and the redirect both stand down, exactly as the
    // no-users check does — a read that cannot answer is not a state.
    expect(shellGate({ ...base, hasUser: true, resumeSetup: true, offline: true })).toBe("render");
  });
});

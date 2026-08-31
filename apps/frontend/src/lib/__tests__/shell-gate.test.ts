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
};

describe("shellGate", () => {
  it("holds a blank first paint while the session is still loading (server up)", () => {
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

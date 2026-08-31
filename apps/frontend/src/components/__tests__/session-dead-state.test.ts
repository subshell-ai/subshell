import { describe, expect, it } from "bun:test";
import { isSessionDead, isSessionExited } from "@/components/session-terminal";
import type { SessionView } from "@/types/session";

/** Minimal record per test — only the fields the predicates read. */
function view(partial: Partial<SessionView>): SessionView {
  return { status: "running", alive: true, ...partial } as SessionView;
}

describe("session dead-state predicates", () => {
  it("isSessionExited stays the crashed-while-managed state", () => {
    expect(isSessionExited(view({ status: "running", alive: false }))).toBe(true);
    expect(isSessionExited(view({ status: "running", alive: true }))).toBe(false);
    // terminated is NOT "exited" — the badge and copy name it directly.
    expect(isSessionExited(view({ status: "terminated" }))).toBe(false);
  });

  it("isSessionDead covers both dead shapes that get the restart panel", () => {
    // crashed while managed (backoff/manual decision pending)
    expect(isSessionDead(view({ status: "running", alive: false }))).toBe(true);
    // explicitly terminated — revisiting it must offer Restart/Delete,
    // not the bare "Session is not running" fallback (2026-08-31 report).
    expect(isSessionDead(view({ status: "terminated" }))).toBe(true);
    // alive states stay out
    expect(isSessionDead(view({ status: "running", alive: true }))).toBe(false);
    expect(isSessionDead(undefined)).toBe(false);
  });
});

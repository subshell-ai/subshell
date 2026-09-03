import { describe, expect, it } from "bun:test";
import { isSubshellDead, isSubshellExited } from "@/components/subshell-terminal";
import type { SubshellView } from "@/types/subshell";

/** Minimal record per test — only the fields the predicates read. */
function view(partial: Partial<SubshellView>): SubshellView {
  return { status: "running", alive: true, ...partial } as SubshellView;
}

describe("subshell dead-state predicates", () => {
  it("isSubshellExited stays the crashed-while-managed state", () => {
    expect(isSubshellExited(view({ status: "running", alive: false }))).toBe(true);
    expect(isSubshellExited(view({ status: "running", alive: true }))).toBe(false);
    // terminated is NOT "exited" — the badge and copy name it directly.
    expect(isSubshellExited(view({ status: "terminated" }))).toBe(false);
  });

  it("isSubshellDead covers both dead shapes that get the restart panel", () => {
    // crashed while managed (backoff/manual decision pending)
    expect(isSubshellDead(view({ status: "running", alive: false }))).toBe(true);
    // explicitly terminated — revisiting it must offer Restart/Delete,
    // not the bare "Subshell is not running" fallback (2026-08-31 report).
    expect(isSubshellDead(view({ status: "terminated" }))).toBe(true);
    // alive states stay out
    expect(isSubshellDead(view({ status: "running", alive: true }))).toBe(false);
    expect(isSubshellDead(undefined)).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { subshellIndicator } from "@/lib/subshell-indicator";
import type { SubshellView } from "@/types/subshell";

/**
 * The filter, tested as the pure predicate it is.
 *
 * `GET /api/subshells` returns every subshell the caller can SEE — for an
 * ADMIN, every subshell on the instance. The server's push path sends only to
 * the owner, only when the bell is on. `.claude/rules/security-context.md`:
 * "Sharing widens who can see/act on a subshell; it never widens who gets
 * pushed about it." These pin that the desktop path agrees.
 */
function notifiable(subshells: SubshellView[]): SubshellView[] {
  return subshells.filter((s) => s.access === "owner" && s.notify && subshellIndicator(s) === "waiting");
}

const base = {
  status: "running",
  alive: true,
  activity: "idle",
  nodeOffline: false,
  waitingSince: new Date().toISOString(),
} as unknown as SubshellView;

const subshell = (over: Partial<SubshellView>): SubshellView => ({ ...base, ...over }) as SubshellView;

describe("which subshells the desktop notifies about", () => {
  it("notifies about the viewer's own belled subshell that is waiting", () => {
    const s = subshell({ id: "a", name: "mine", access: "owner", notify: true });
    expect(notifiable([s]).map((x) => x.id)).toEqual(["a"]);
  });

  // An admin's list is every subshell on the instance.
  it("never notifies about someone else's subshell", () => {
    const rows = [
      subshell({ id: "b", name: "theirs", access: "edit", notify: true }),
      subshell({ id: "c", name: "theirs too", access: "view", notify: true }),
    ];
    expect(notifiable(rows)).toEqual([]);
  });

  // The owner-only bell (PATCH /api/subshells/:id/notify).
  it("never notifies about a muted subshell", () => {
    expect(notifiable([subshell({ id: "d", name: "muted", access: "owner", notify: false })])).toEqual([]);
  });

  it("ignores a subshell that is not waiting", () => {
    const s = subshell({
      id: "e",
      name: "busy",
      access: "owner",
      notify: true,
      waitingSince: null,
      activity: "active",
    });
    expect(notifiable([s])).toEqual([]);
  });
});

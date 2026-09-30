import { describe, expect, it } from "bun:test";
import { formDialogOpenChange } from "@/components/ui/dialog";

/**
 * The new/edit dialogs close only on a deliberate act (operator ruling
 * 2026-09-30): an outside press or Escape must not silently discard a
 * half-filled preset. This pins the guard's reason table directly; the
 * dialogs' click-through wiring is exercised in their own suites.
 */
describe("formDialogOpenChange", () => {
  it("ignores the accidental closes and passes the deliberate ones", () => {
    const seen: boolean[] = [];
    const guard = formDialogOpenChange((open) => seen.push(open));
    guard(false, { reason: "outside-press" });
    guard(false, { reason: "escape-key" });
    expect(seen).toEqual([]);
    guard(false, { reason: "close-press" });
    guard(false, { reason: "none" });
    guard(true, { reason: "trigger-press" });
    expect(seen).toEqual([false, false, true]);
  });
});

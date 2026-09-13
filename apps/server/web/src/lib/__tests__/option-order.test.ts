import { describe, expect, it } from "bun:test";
import { usableFirst } from "@/lib/option-order";

describe("usableFirst", () => {
  it("floats the usable rows and sinks the rest", () => {
    const rows = [
      { id: "codex", ok: false },
      { id: "claude", ok: true },
      { id: "pi", ok: false },
      { id: "terminal", ok: true },
    ];
    expect(usableFirst(rows, (r) => r.ok).map((r) => r.id)).toEqual(["claude", "terminal", "codex", "pi"]);
  });

  it("is stable within each group — the caller's order carries meaning", () => {
    // Presets arrive sorted and nodes arrive with the control plane's row
    // first; re-sorting either would trade one confusing order for another.
    const rows = ["b", "a", "d", "c"].map((id, i) => ({ id, ok: i % 2 === 0 }));
    expect(usableFirst(rows, (r) => r.ok).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("leaves an all-usable or all-greyed list exactly as it was", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(usableFirst(rows, () => true)).toEqual(rows);
    expect(usableFirst(rows, () => false)).toEqual(rows);
  });

  it("returns a new array rather than sorting the caller's in place", () => {
    const rows = [{ ok: false }, { ok: true }];
    const out = usableFirst(rows, (r) => r.ok);
    expect(out).not.toBe(rows);
    expect(rows[0]?.ok).toBe(false);
  });
});

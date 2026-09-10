import { describe, expect, it } from "bun:test";
import { checkedAtLabel } from "@/lib/checked-at";

describe("checkedAtLabel", () => {
  it("is silent when there is no stamp", () => {
    // A probe that never ran reports nothing here; that is unknown, not "never".
    expect(checkedAtLabel(undefined)).toBeNull();
  });

  it("is silent for an unparseable stamp", () => {
    expect(checkedAtLabel("not a date")).toBeNull();
  });

  it("does not append 'ago' to 'just now'", () => {
    expect(checkedAtLabel(new Date().toISOString())).toBe("checked just now");
  });

  it("appends 'ago' to an elapsed duration", () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(checkedAtLabel(tenMinutesAgo)).toBe("checked 10m ago");
  });
});

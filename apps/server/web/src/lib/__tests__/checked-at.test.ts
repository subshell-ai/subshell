import { describe, expect, it, setSystemTime } from "bun:test";
import { checkedAtLabel } from "@/lib/checked-at";

/**
 * The elapsed cases pin the clock. `checkedAtLabel` measures NOW against the
 * stamp, and on a loaded runner the gap between building a stamp and
 * asserting its label is no longer reliably sub-second — a straddled minute
 * boundary would fail the string through no fault of the code. Pinning makes
 * both branches exact and stays honest: the function still reads the real
 * Date.now, only the machine's now is fixed for the duration of one test.
 */
const NOW = new Date("2026-09-10T12:00:00.000Z");

describe("checkedAtLabel", () => {
  it("is silent when there is no stamp", () => {
    // A probe that never ran reports nothing here; that is unknown, not "never".
    expect(checkedAtLabel(undefined)).toBeNull();
  });

  it("is silent for an unparseable stamp", () => {
    expect(checkedAtLabel("not a date")).toBeNull();
  });

  it("does not append 'ago' to 'just now'", () => {
    setSystemTime(NOW);
    try {
      expect(checkedAtLabel(NOW.toISOString())).toBe("checked just now");
    } finally {
      setSystemTime();
    }
  });

  it("appends 'ago' to an elapsed duration", () => {
    setSystemTime(NOW);
    try {
      const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
      expect(checkedAtLabel(tenMinutesAgo)).toBe("checked 10m ago");
    } finally {
      setSystemTime();
    }
  });
});

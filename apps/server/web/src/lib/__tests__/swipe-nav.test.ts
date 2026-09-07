import { describe, expect, it } from "bun:test";
import { swipeIntent } from "@/lib/swipe-nav";

const W = 390;

/** Convenience: swipe `dx` px from x=`startX` (default screen centre). */
function intent(dx: number, dy = 0, startX = W / 2) {
  return swipeIntent({ dx, dy, startX, viewportWidth: W });
}

describe("swipeIntent", () => {
  it("a left swipe past the threshold asks for the next entry", () => {
    expect(intent(-120)).toBe("next");
    expect(intent(-70)).toBe("next"); // threshold is inclusive
  });

  it("a right swipe past the threshold asks for the previous entry", () => {
    expect(intent(120)).toBe("prev");
  });

  it("short drags do nothing", () => {
    expect(intent(-69)).toBeNull();
    expect(intent(0)).toBeNull();
  });

  it("vertical-dominant drags do nothing — terminal scrollback owns them", () => {
    expect(intent(-100, -90)).toBeNull(); // 100 <= 90 * 1.3
    expect(intent(-100, -70)).toBe("next"); // 100 > 70 * 1.3
  });

  it("gestures starting inside the edge guard belong to the browser back", () => {
    expect(intent(-120, 0, 12)).toBeNull();
    expect(intent(120, 0, W - 12)).toBeNull();
  });
});

/**
 * The Copy button's flash, which is the third time this app has had to move a
 * piece of state out of an element the render rebuilds.
 *
 * The bug these pin: the assistant re-renders every 1500 ms and rebuilds the
 * button, so a tick held in the DOM survived a uniformly random 0–1500 ms of
 * its 1600. Everything here is about a flash outliving the element that
 * started it, and expiring on time anyway.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { clearFlashesForTests, FLASH_MS, flashAt, readFlash, setFlash } from "../lib/copy-flash";

beforeEach(() => {
  clearFlashesForTests();
});

describe("flashAt", () => {
  it("is idle when nothing has been copied", () => {
    expect(flashAt(undefined, 1_000)).toEqual({ state: "idle", remaining: 0 });
  });

  it("reports the flash and what is left of it while it runs", () => {
    expect(flashAt({ state: "copied", until: 2_600 }, 1_000)).toEqual({ state: "copied", remaining: 1_600 });
    expect(flashAt({ state: "copied", until: 2_600 }, 2_100)).toEqual({ state: "copied", remaining: 500 });
  });

  it("carries the failure the same way", () => {
    // A refused clipboard has to show SOMETHING, or the press reads as one
    // that never registered — so `failed` is a flash, not an absence of one.
    expect(flashAt({ state: "failed", until: 2_600 }, 1_000).state).toBe("failed");
  });

  it("goes idle exactly at the deadline, not after it", () => {
    // Expiry is by timestamp rather than by a timer having fired, because the
    // timer belongs to an element a render may already have discarded.
    expect(flashAt({ state: "copied", until: 2_600 }, 2_599).state).toBe("copied");
    expect(flashAt({ state: "copied", until: 2_600 }, 2_600).state).toBe("idle");
    expect(flashAt({ state: "copied", until: 2_600 }, 9_999).state).toBe("idle");
  });
});

describe("the flash store", () => {
  it("shows a press to the button that is built after it", () => {
    // This IS the bug: the element that was pressed is gone, and the one the
    // render built in its place has to show the same thing.
    setFlash("brew install tmux", "copied", 1_000);
    expect(readFlash("brew install tmux", 1_100)).toEqual({ state: "copied", remaining: FLASH_MS - 100 });
  });

  it("keeps two buttons' flashes apart", () => {
    setFlash("brew install tmux", "copied", 1_000);
    expect(readFlash("sudo port install tmux", 1_100).state).toBe("idle");
  });

  it("forgets a slot once it is spent, rather than keeping one entry per string", () => {
    setFlash("a", "copied", 1_000);
    expect(readFlash("a", 1_000 + FLASH_MS).state).toBe("idle");
    // Nothing observable distinguishes an evicted slot from an expired one, so
    // the pin is that a later read still answers idle rather than resurrecting.
    expect(readFlash("a", 1_000 + 1).state).toBe("idle");
  });

  it("lets a second press extend the flash instead of inheriting the first deadline", () => {
    setFlash("a", "copied", 1_000);
    setFlash("a", "copied", 2_000);
    // The first press's timer fires here and must not rest the button: that
    // is why the rest re-reads the store instead of painting idle blindly.
    expect(readFlash("a", 1_000 + FLASH_MS).state).toBe("copied");
    expect(readFlash("a", 2_000 + FLASH_MS).state).toBe("idle");
  });

  it("replaces a failure with the success that follows it", () => {
    setFlash("a", "failed", 1_000);
    setFlash("a", "copied", 1_200);
    expect(readFlash("a", 1_300).state).toBe("copied");
  });

  it("outlasts the poll it is rebuilt by, which is the whole point", () => {
    // 1500 ms is `POLL_MS`. A flash shorter than one interval would need none
    // of this; the reason it does is that it is longer.
    expect(FLASH_MS).toBeGreaterThan(1_500);
  });
});

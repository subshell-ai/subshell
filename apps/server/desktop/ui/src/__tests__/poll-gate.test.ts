import { describe, expect, test } from "bun:test";
import { pollShouldRender } from "../lib/poll-gate";

describe("pollShouldRender", () => {
  test("an unchanged signature skips the render", () => {
    expect(pollShouldRender("same", "same", false)).toBe(false);
  });

  test("a changed signature renders", () => {
    expect(pollShouldRender("same", "changed", false)).toBe(true);
  });

  test("a skipped tick owes a catch-up render even with an unchanged signature", () => {
    // The blind spot the gate exists around: state mutated during a skip
    // window (the port answer that lands while the field is focused) is
    // invisible to before/after snapshots taken on either side of the change.
    expect(pollShouldRender("same", "same", true)).toBe(true);
  });

  test("a catch-up render is owed the same when the signature moved", () => {
    expect(pollShouldRender("same", "changed", true)).toBe(true);
  });
});

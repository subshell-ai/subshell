import { describe, expect, it } from "bun:test";
import { findNeighbors } from "@/lib/subshell-neighbors";

const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("findNeighbors", () => {
  it("returns the id-list neighbours around the current entry", () => {
    expect(findNeighbors(list, "b")).toEqual({ prev: "a", next: "c" });
  });

  it("ends have one neighbour only — no wrap-around", () => {
    expect(findNeighbors(list, "a")).toEqual({ prev: null, next: "b" });
    expect(findNeighbors(list, "c")).toEqual({ prev: "b", next: null });
  });

  it("an unknown or not-yet-listed id has no neighbours (swipe stays inert)", () => {
    expect(findNeighbors(list, "zz")).toEqual({ prev: null, next: null });
    expect(findNeighbors([], "a")).toEqual({ prev: null, next: null });
  });
});

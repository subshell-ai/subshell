import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { isChunkLoadFailure, RouteError } from "@/components/route-error";

afterEach(cleanup);

describe("isChunkLoadFailure", () => {
  it("recognizes the per-browser spellings of a dead lazy chunk", () => {
    expect(isChunkLoadFailure(new TypeError("Failed to fetch dynamically imported module: https://x/y.js"))).toBe(true);
    expect(isChunkLoadFailure(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadFailure(new Error("Unable to preload CSS for /assets/x.css"))).toBe(false);
    expect(isChunkLoadFailure(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadFailure("Loading chunk 42 failed")).toBe(true);
  });
});

describe("RouteError", () => {
  it("a plain error shows its message and the two escapes", () => {
    render(<RouteError error={new Error("boom went the render")} />);
    expect(screen.getByText("This page hit an error")).toBeTruthy();
    expect(screen.getByText("boom went the render")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to sessions" })).toBeTruthy();
  });

  it("a chunk failure whose guarded reload already happened says so instead of reloading again", () => {
    sessionStorage.setItem("subshell-chunk-reload-at", String(Date.now()));
    render(<RouteError error={new TypeError("Failed to fetch dynamically imported module: https://x/y.js")} />);
    expect(screen.getByText(/did not help/)).toBeTruthy();
    sessionStorage.removeItem("subshell-chunk-reload-at");
  });
});

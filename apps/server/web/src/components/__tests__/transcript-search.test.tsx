import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TranscriptSearch } from "@/components/transcript-search";

/**
 * The open/close contract the subshell page's header depends on: on phones the
 * Find bar vacates the header row beside it (badge + actions menu hide while
 * open), so every transition — button, ✕, Escape — must reach `onOpenChange`.
 * `search` stays null: the addon is only needed for matching, not for the
 * open/close lifecycle under test.
 */
afterEach(cleanup);

describe("TranscriptSearch open/close contract", () => {
  it("the Find button opens the bar and reports the flip", () => {
    const seen: boolean[] = [];
    render(<TranscriptSearch search={null} onClose={() => {}} onOpenChange={(o) => seen.push(o)} />);
    fireEvent.click(screen.getByRole("button", { name: "Find in terminal" }));
    expect(screen.getByPlaceholderText("Find…")).toBeTruthy();
    expect(seen).toEqual([true]);
  });

  it("the ✕ closes the bar and reports it", () => {
    const seen: boolean[] = [];
    render(<TranscriptSearch search={null} onClose={() => {}} onOpenChange={(o) => seen.push(o)} />);
    fireEvent.click(screen.getByRole("button", { name: "Find in terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.queryByPlaceholderText("Find…")).toBeNull();
    expect(seen).toEqual([true, false]);
  });

  it("Escape closes the bar too — same report, same exit", () => {
    const seen: boolean[] = [];
    render(<TranscriptSearch search={null} onClose={() => {}} onOpenChange={(o) => seen.push(o)} />);
    fireEvent.click(screen.getByRole("button", { name: "Find in terminal" }));
    fireEvent.keyDown(screen.getByPlaceholderText("Find…"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("Find…")).toBeNull();
    expect(seen).toEqual([true, false]);
  });

  it("works without onOpenChange (the dock's call site passes no callback)", () => {
    render(<TranscriptSearch search={null} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Find in terminal" }));
    expect(screen.getByPlaceholderText("Find…")).toBeTruthy();
  });
});

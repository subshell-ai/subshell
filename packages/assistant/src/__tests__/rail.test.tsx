import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Rail, type RailSection } from "../rail";

// One document per process (the global registrator): a render that is not
// unmounted leaves its tree for the next test's queries.
afterEach(cleanup);

const SECTIONS: RailSection[] = [
  { id: "status", label: "Status" },
  { id: "update", label: "Update" },
  { id: "supervision", label: "How it runs" },
  { id: "settings", label: "Addresses" },
];

describe("Rail", () => {
  it("is one named navigation with a button per section, in the given order", () => {
    render(<Rail sections={SECTIONS} active={null} onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).toBeDefined();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Status", "Update", "How it runs", "Addresses"]);
  });

  it("marks the active section with aria-current, and nothing when active is null", () => {
    const { unmount } = render(<Rail sections={SECTIONS} active="update" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Update" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Status" }).getAttribute("aria-current")).toBe("false");
    unmount();
    render(<Rail sections={SECTIONS} active={null} onSelect={() => {}} />);
    for (const label of SECTIONS.map((s) => s.label)) {
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-current")).toBe("false");
    }
  });

  it("styles a danger section in the destructive token, and never marks it active", () => {
    render(
      <Rail
        sections={[
          { id: "status", label: "Status" },
          { id: "reset", label: "Reset", danger: true },
        ]}
        active={null}
        onSelect={() => {}}
      />,
    );
    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset.className).toContain("text-destructive");
    expect(reset.className).not.toContain("linear-gradient");
    expect(screen.getByRole("button", { name: "Status" }).className).toContain("text-muted-foreground");
  });

  it("keeps a danger section in the danger styling even when a caller marks it active", () => {
    // Structural, not caller discipline: the active gradient is FORBIDDEN for
    // a destructive section, whoever asks for it.
    render(
      <Rail
        sections={[
          { id: "status", label: "Status" },
          { id: "reset", label: "Reset", danger: true },
        ]}
        active="reset"
        onSelect={() => {}}
      />,
    );
    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset.className).toContain("text-destructive");
    expect(reset.className).not.toContain("linear-gradient");
  });

  it("selects with the section's id", () => {
    const picked: string[] = [];
    render(<Rail sections={SECTIONS} active="status" onSelect={(id) => picked.push(id)} />);
    screen.getByRole("button", { name: "Addresses" }).click();
    screen.getByRole("button", { name: "Status" }).click();
    expect(picked).toEqual(["settings", "status"]);
  });
});

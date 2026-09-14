import { describe, expect, test } from "bun:test";
import { cn } from "@/lib/cn";

describe("cn knows the design-system roles are font-sizes", () => {
  test("a role size survives a colour class", () => {
    expect(cn("text-heading", "text-muted-foreground")).toContain("text-heading");
    expect(cn("text-heading", "text-muted-foreground")).toContain("text-muted-foreground");
  });
  test("roles still conflict with other sizes, last wins", () => {
    expect(cn("text-heading", "text-label")).toBe("text-label");
    expect(cn("text-sm", "text-caption")).toBe("text-caption");
  });
  test("roles override each other both directions", () => {
    expect(cn("text-caption", "text-body")).toBe("text-body");
  });
  test("font-weight is its own group: a weight never evicts a family", () => {
    // Measured, final review 2026-09-14: unregistered, `font-strong` fell
    // into tailwind-merge's font-FAMILY group and silently evicted `font-mono`.
    expect(cn("font-mono", "font-strong")).toBe("font-mono font-strong");
  });
  test("weights replace each other, last wins", () => {
    expect(cn("font-strong", "font-medium")).toBe("font-medium");
  });
});

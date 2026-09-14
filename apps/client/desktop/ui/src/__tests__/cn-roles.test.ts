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
});

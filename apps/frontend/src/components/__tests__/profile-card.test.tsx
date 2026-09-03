import { describe, expect, it } from "bun:test";
import { nameIsUsable } from "@/components/profile-card";

/** The Profile card's only rule (spec 2026-09-02 settings-split §1.1): the
 * display name saves trimmed and must not be blank; email is read-only.
 * The better-auth call itself is the client's — mocked in the component test
 * tradition of this suite, so only the rule is pinned here. */
describe("nameIsUsable", () => {
  it("accepts anything non-blank and saves it trimmed", () => {
    expect(nameIsUsable("Thea")).toBe("Thea");
    expect(nameIsUsable("  Thea G  ")).toBe("Thea G");
    expect(nameIsUsable("   ")).toBeNull();
    expect(nameIsUsable("")).toBeNull();
  });
});

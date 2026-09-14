import { describe, expect, it } from "bun:test";
import { MIN_PASSWORD_LENGTH, PASSWORD_REQUIREMENT, passwordTooShort } from "@/lib/password";

describe("the password rule", () => {
  it("states the requirement in the same number it enforces", () => {
    expect(PASSWORD_REQUIREMENT).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("refuses anything under the minimum, including nothing at all", () => {
    expect(passwordTooShort("")).toBe(true);
    expect(passwordTooShort("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(true);
  });

  it("accepts the minimum exactly", () => {
    expect(passwordTooShort("a".repeat(MIN_PASSWORD_LENGTH))).toBe(false);
  });
});

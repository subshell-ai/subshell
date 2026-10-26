import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COPYRIGHT_LINE, LICENSE_EXCEPTION_SUMMARY, LICENSE_SUMMARY, LICENSE_URL, licenseNotice } from "../legal.js";

describe("licenseNotice", () => {
  const notice = licenseNotice("subshell", "1.2.3");

  test("opens with the binary and version, then the copyright", () => {
    const [first, second] = notice.split("\n");
    expect(first).toBe("subshell 1.2.3");
    expect(second).toBe(COPYRIGHT_LINE);
  });

  test("carries the licence summary, the full-text URL and the section 7 exception", () => {
    expect(notice).toContain(LICENSE_SUMMARY);
    expect(notice).toContain(LICENSE_URL);
    // Wrapped for the terminal, so assert on the words rather than the
    // stored sentence — the constant is one line, the output is three.
    expect(notice).toContain("API Type Surface exception");
    expect(notice).toContain("not copyleft");
  });

  test("ends in exactly one newline, so a CLI can write it verbatim", () => {
    expect(notice.endsWith("\n")).toBe(true);
    expect(notice.endsWith("\n\n")).toBe(false);
  });

  // A terminal is the only consumer that cannot reflow, so the wrap is the
  // one formatting promise this function makes.
  test("wraps the introductory summary inside 80 columns", () => {
    for (const line of notice.split("===== LICENSE =====")[0].split("\n")) expect(line.length).toBeLessThanOrEqual(79);
  });

  test("the exception sentence survives wrapping with its words intact", () => {
    const flattened = notice.split("\n").join(" ");
    expect(flattened).toContain(LICENSE_EXCEPTION_SUMMARY);
  });
});

// Exact document comparisons catch truncation and stale generated copies.
for (const binary of ["subshell", "subshell-server"]) {
  test(`${binary} provides complete license documents without runtime files`, () => {
    const output = licenseNotice(binary, "1.2.3");
    for (const name of ["LICENSE", "apps/server/LICENSE", "NOTICE"]) {
      const text = readFileSync(new URL(`../../../../${name}`, import.meta.url), "utf8");
      expect(output).toContain(text.trimEnd());
    }
  });
}

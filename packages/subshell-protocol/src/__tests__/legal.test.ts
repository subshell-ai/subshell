import { describe, expect, test } from "bun:test";
import {
  COPYRIGHT_HOLDER,
  COPYRIGHT_LINE,
  COPYRIGHT_YEAR,
  LICENSE_EXCEPTION_SUMMARY,
  LICENSE_SUMMARY,
  LICENSE_URL,
  licenseNotice,
} from "../legal.js";

describe("legal constants", () => {
  test("the copyright line is composed of its parts", () => {
    expect(COPYRIGHT_LINE).toBe(`Copyright ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`);
  });

  // The registered entity, not the DBA. A trade name cannot hold title or
  // contract, which is why CLA.md names this string specifically.
  test("the holder is the registered entity", () => {
    expect(COPYRIGHT_HOLDER).toBe("Disaresta, LLC");
  });

  // "Dual-licensed" alone leaves a reader unable to tell what governs the part
  // they are holding, which is the only question the line exists to answer.
  test("the summary names both halves and which is which", () => {
    expect(LICENSE_SUMMARY).toContain("AGPL-3.0-only");
    expect(LICENSE_SUMMARY).toContain("Apache-2.0");
    expect(LICENSE_SUMMARY).toContain("control plane");
  });
});

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
  test("wraps every line inside 80 columns", () => {
    for (const line of notice.split("\n")) expect(line.length).toBeLessThanOrEqual(79);
  });

  test("the exception sentence survives wrapping with its words intact", () => {
    const flattened = notice.split("\n").join(" ");
    expect(flattened).toContain(LICENSE_EXCEPTION_SUMMARY);
  });
});

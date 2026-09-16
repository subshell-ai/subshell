import { describe, expect, it } from "bun:test";
import { safeHref } from "@/lib/safe-href";

/**
 * The sink's own check on URLs the page did not write.
 *
 * The server strips these too — the manifest parser at load, the network gate
 * at runtime — so this is the third layer and the only one that cannot be
 * bypassed by an upstream omission. It is here rather than left to React
 * because React 19's neutralizing of a `javascript:` href is an internal of a
 * rendering library, and React 18 only warned.
 */
describe("safeHref", () => {
  it("passes through the two schemes a browser navigates to", () => {
    expect(safeHref("https://tailscale.com/kb/1080/cli")).toBe("https://tailscale.com/kb/1080/cli");
    expect(safeHref("http://headscale.internal/docs")).toBe("http://headscale.internal/docs");
  });

  it("answers undefined for a scheme that executes, so the caller renders no link", () => {
    expect(safeHref("javascript:alert(document.cookie)")).toBeUndefined();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeHref("file:///etc/passwd")).toBeUndefined();
  });

  it("is not fooled by the spellings that get past a prefix check", () => {
    // Each of these still executes in a browser, and each survives
    // `startsWith("javascript:")`. Parsing the URL is what settles it.
    expect(safeHref("\u0000javascript:alert(1)")).toBeUndefined();
    expect(safeHref("  javascript:alert(1)")).toBeUndefined();
    expect(safeHref("java\tscript:alert(1)")).toBeUndefined();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeUndefined();
  });

  it("refuses a relative URL, which would resolve against this origin", () => {
    expect(safeHref("/settings/networking")).toBeUndefined();
    expect(safeHref("tailscale.com/kb")).toBeUndefined();
  });

  it("passes undefined through, for the common case of an absent field", () => {
    expect(safeHref(undefined)).toBeUndefined();
  });
});

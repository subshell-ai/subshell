import { describe, expect, it } from "bun:test";
import { safeRedirect } from "@/lib/redirect";

describe("safeRedirect", () => {
  it("accepts same-origin absolute paths", () => {
    expect(safeRedirect("/workspaces")).toBe("/workspaces");
    expect(safeRedirect("/sessions/abc?tab=logs")).toBe("/sessions/abc?tab=logs");
  });
  it("rejects anything that could leave the app", () => {
    expect(safeRedirect("//evil.com")).toBeNull();
    expect(safeRedirect("/\\evil.com")).toBeNull();
    expect(safeRedirect("https://evil.com")).toBeNull();
    expect(safeRedirect("workspaces")).toBeNull();
    expect(safeRedirect("")).toBeNull();
    expect(safeRedirect(undefined)).toBeNull();
    expect(safeRedirect(null)).toBeNull();
  });
  it("rejects protocol-relative variants that smuggle a host", () => {
    // Pins the startsWith("//") veto against triple-slash forms too.
    expect(safeRedirect("///evil.com")).toBeNull();
  });
  it("rejects C0 control chars stripped by WHATWG URL parsing", () => {
    // A `?redirect=/%09/evil.com` URL-decodes to a tab-prefixed path; the URL
    // parser used by window.location.href strips tabs/newlines before
    // resolving, collapsing it to the protocol-relative "//evil.com".
    expect(safeRedirect("/\t/evil.com")).toBeNull();
    expect(safeRedirect("/\n/evil.com")).toBeNull();
    expect(safeRedirect("/\r/evil.com")).toBeNull();
  });
});

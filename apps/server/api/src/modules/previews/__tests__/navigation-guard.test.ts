import { describe, expect, it } from "bun:test";
import { previewRefusalPage, strandingNavigationReason } from "../navigation-guard.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0";

const HTML: [string, string][] = [["content-type", "text/html; charset=utf-8"]];
const PDF: [string, string][] = [["content-type", "application/pdf"]];
const CSV_DOWNLOAD: [string, string][] = [
  ["content-type", "text/csv"],
  ["content-disposition", "attachment; filename=x.csv"],
];

function request(headers: Record<string, string>, url = "http://plane/pv/abc123/some/path"): Request {
  return new Request(url, { headers });
}

describe("the stranding navigation guard", () => {
  it("refuses a file an iOS client could be handed off to", () => {
    expect(
      strandingNavigationReason(request({ "sec-fetch-dest": "document", "user-agent": IPHONE }), "report.pdf", {
        status: 200,
        headers: PDF,
      }),
    ).toBe("not-a-page");
    expect(
      strandingNavigationReason(
        request({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "user-agent": IPHONE }),
        "export",
        { status: 200, headers: CSV_DOWNLOAD },
      ),
    ).toBe("download");
  });

  it("leaves the desktop alone, where the browser's own UI handles the file", () => {
    expect(
      strandingNavigationReason(request({ "sec-fetch-dest": "document", "user-agent": DESKTOP }), "export", {
        status: 200,
        headers: CSV_DOWNLOAD,
      }),
    ).toBeNull();
  });

  it("paints documents, including ones that forgot to say what they are", () => {
    const nav = request({ "sec-fetch-dest": "document", "user-agent": IPHONE });
    expect(strandingNavigationReason(nav, "", { status: 200, headers: HTML })).toBeNull();
    expect(
      strandingNavigationReason(nav, "", { status: 200, headers: [["content-type", "application/xhtml+xml"]] }),
    ).toBeNull();
    // No declared type is not a claim of being a file, and a browser renders such
    // a body as text rather than handing it to a system viewer.
    expect(strandingNavigationReason(nav, "", { status: 200, headers: [] })).toBeNull();
  });

  it("never intercepts a subresource, whatever it returns", () => {
    // The guard protects the top-level presentation; app CSS, images and fetches
    // keep their own types or no page would render.
    expect(
      strandingNavigationReason(request({ "sec-fetch-dest": "image", "user-agent": IPHONE }), "logo.png", {
        status: 200,
        headers: [["content-type", "image/png"]],
      }),
    ).toBeNull();
    expect(
      strandingNavigationReason(request({ "sec-fetch-dest": "empty", "user-agent": IPHONE }), "api/x", {
        status: 200,
        headers: [["content-type", "application/json"]],
      }),
    ).toBeNull();
  });

  it("keeps the app's own answers, including the unhappy ones", () => {
    // A navigation the person chose is theirs to read: an auth wall or a crash
    // page is information, while a redirect is the app's business.
    const nav = request({ "sec-fetch-dest": "document", "user-agent": IPHONE });
    expect(strandingNavigationReason(nav, "login", { status: 401, headers: HTML })).toBeNull();
    expect(strandingNavigationReason(nav, "boom", { status: 500, headers: HTML })).toBeNull();
    expect(strandingNavigationReason(nav, "gone", { status: 404, headers: [] })).toBeNull();
    expect(strandingNavigationReason(nav, "moved", { status: 302, headers: PDF })).toBeNull();
    expect(strandingNavigationReason(nav, "nope", { status: 204, headers: [] })).toBeNull();
  });

  it("treats a bare capability root as a navigation only when the client offers a page", () => {
    // With no Sec-Fetch-* to trust (a plain HTTP client), the session root plus an
    // explicit offer of a document type is the navigation. A wildcard offer, or a
    // deeper path, is not.
    const root = "http://plane/pv/abc123/";
    expect(
      strandingNavigationReason(
        request({ accept: "text/html,application/xhtml+xml;q=0.9", "user-agent": IPHONE }, root),
        "",
        {
          status: 200,
          headers: PDF,
        },
      ),
    ).toBe("not-a-page");
    expect(
      strandingNavigationReason(request({ accept: "*/*", "user-agent": IPHONE }, root), "", {
        status: 200,
        headers: PDF,
      }),
    ).toBeNull();
    expect(
      strandingNavigationReason(request({ accept: "text/html", "user-agent": IPHONE }), "api/x", {
        status: 200,
        headers: [["content-type", "application/json"]],
      }),
    ).toBeNull();
  });

  it("announces the refusal with a fixed marker, its own ref, and no app words", () => {
    const ref = "a".repeat(32);
    const page = previewRefusalPage(ref, "http://plane:3080", "download");
    expect(page).toContain("subshell:preview-refused");
    expect(page).toContain(`"ref":"${ref}"`);
    expect(page).toContain('"reason":"download"');
    expect(page).toContain("postMessage(");
    // The origin the message is pinned to is the plane's own, and `<` is escaped,
    // so no value can close the script element and write its own.
    const hostile = previewRefusalPage(ref, 'http://plane"><script>alert(1)</script', "not-a-page");
    expect(hostile).not.toContain("<script>alert");
  });
});

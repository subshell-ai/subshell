import { describe, expect, it } from "bun:test";
import { installAddresses, installPlatformFor } from "@/lib/mobile-install";

describe("installAddresses", () => {
  it("drops loopback: a phone cannot use the row no matter how it is labelled", () => {
    // This row used to be KEPT and labelled "this device only", because on a
    // stock instance every address looked loopback and a vanishing address is
    // its own confusion. Since the server derives its own LAN interfaces into
    // the allowlist, that case has real rows now — and this picker is FOR the
    // phone: a localhost row offers it nothing and dilutes the "pick an
    // address your phone can reach" instruction the field gives.
    const list = installAddresses({
      here: "http://localhost:3080",
      baseUrl: "http://localhost:3080",
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080", "https://plane.tail1234.ts.net"],
    });
    expect(list.map((a) => a.url)).toEqual(["https://plane.tail1234.ts.net"]);
  });

  it("answers nothing when the instance knows no phone-dialable address", () => {
    // A loopback bind on a server older than the LAN derivation. The dialog
    // shows its empty state here, not a QR of the wrong machine's localhost.
    const list = installAddresses({
      here: "http://localhost:3080",
      baseUrl: undefined,
      trustedOrigins: ["http://localhost:3080", "http://127.0.0.1:3080", "http://[::1]:3080"],
    });
    expect(list).toEqual([]);
  });

  it("deduplicates the three sources, which usually overlap", () => {
    const list = installAddresses({
      here: "https://plane.tail1234.ts.net",
      baseUrl: "https://plane.tail1234.ts.net",
      trustedOrigins: ["https://plane.tail1234.ts.net"],
    });
    expect(list).toHaveLength(1);
    // The labels accumulate rather than the rows: one address that happens to
    // be all three facts is still one address.
    expect(list[0]?.here).toBe(true);
    expect(list[0]?.baseUrl).toBe(true);
  });

  it("normalizes to origins, so two spellings of one address are one row", () => {
    const list = installAddresses({
      here: "https://plane.tail1234.ts.net/subshells/abc?tab=logs",
      baseUrl: "https://plane.tail1234.ts.net/",
      trustedOrigins: [],
    });
    expect(list.map((a) => a.url)).toEqual(["https://plane.tail1234.ts.net"]);
  });

  it("keeps the address this browser is on ahead of the base URL", () => {
    // The one that demonstrably works from a browser on this network is the
    // better guess for the phone beside it.
    const list = installAddresses({
      here: "http://192.168.1.14:3080",
      baseUrl: "https://plane.tail1234.ts.net",
      trustedOrigins: ["https://plane.tail1234.ts.net", "http://192.168.1.14:3080"],
    });
    expect(list[0]?.url).toBe("http://192.168.1.14:3080");
    expect(list[1]?.url).toBe("https://plane.tail1234.ts.net");
  });

  it("keeps the server's own LAN addresses in the allowlist's order", () => {
    // Neither here nor baseUrl is on the LAN (a laptop browsing loopback), so
    // the QR defaults to the first derived address — the fix this rides on.
    const list = installAddresses({
      here: "http://localhost:3080",
      baseUrl: "http://localhost:3080",
      trustedOrigins: ["http://192.168.1.14:3080", "http://10.0.0.7:3080"],
    });
    expect(list.map((a) => a.url)).toEqual(["http://192.168.1.14:3080", "http://10.0.0.7:3080"]);
  });

  it("drops entries that are not parseable origins", () => {
    // TRUSTED_ORIGINS is canonicalized server-side, but a cached PWA can be
    // talking to an older server, and a hand-edited config.env bypasses the
    // validator entirely. A junk entry is dead weight, never a rendered row.
    const list = installAddresses({
      here: "https://plane.example",
      baseUrl: "",
      trustedOrigins: ["", "not a url", "  "],
    });
    expect(list.map((a) => a.url)).toEqual(["https://plane.example"]);
  });

  it("survives a server that does not send the list at all", () => {
    // Optional field: a server predating it sends nothing, and the dialog
    // must still offer the address this browser proves works.
    const list = installAddresses({ here: "https://plane.example", baseUrl: undefined, trustedOrigins: undefined });
    expect(list.map((a) => a.url)).toEqual(["https://plane.example"]);
  });
});

describe("installPlatformFor", () => {
  it("picks the tab that matches the device reading it", () => {
    expect(installPlatformFor("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe(
      "apple",
    );
    expect(installPlatformFor("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("apple");
    expect(installPlatformFor("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36")).toBe("android");
    expect(installPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141")).toBe(
      "browser",
    );
    expect(installPlatformFor("")).toBe("browser");
  });

  it("reads an iPad that lies about being a Mac", () => {
    // iPadOS 13+ Safari sends a desktop Macintosh UA by default. The tell is
    // touch: no Mac reports touch points, and an iPad shown the desktop steps
    // is shown steps its browser does not have.
    expect(installPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5)).toBe("apple");
    expect(installPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0)).toBe(
      "browser",
    );
  });
});

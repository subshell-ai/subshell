import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_BASE_URL, HOST, localOriginsFor, SERVER_PORT, TRUSTED_ORIGINS } from "@/constants.js";

/**
 * better-auth rejects sign-up/sign-in with 403 "Invalid origin" when the
 * browser's Origin header is not in `trustedOrigins`. Two jobs here:
 *
 * 1. Drift guard for dev — the browser origin is the Vite server, so the
 *    default must track the port declared in the frontend's vite.config.ts.
 * 2. The served instance must trust ITSELF. The app binds 127.0.0.1 while
 *    APP_BASE_URL historically spelled `localhost`, and production (unlike
 *    dev) enforces the check strictly: a first-run admin on the address the
 *    boot log prints got 403 on "Create admin account". Both loopback
 *    spellings, the concrete bind host and the base URL's origin are derived
 *    in; wildcard bind hosts are not (they are listen addresses).
 */
describe("TRUSTED_ORIGINS", () => {
  const viteConfigPath = path.resolve(import.meta.dir, "../../../web/vite.config.ts");

  it("includes the Vite dev server origin declared in vite.config.ts", () => {
    const source = readFileSync(viteConfigPath, "utf8");
    const port = source.match(/^\s*port:\s*(\d+)\s*,/m)?.[1];
    expect(port).toBeDefined();
    expect(TRUSTED_ORIGINS).toContain(`http://localhost:${port}`);
  });

  it("trusts both loopback spellings of the port it actually serves", () => {
    expect(TRUSTED_ORIGINS).toContain(`http://localhost:${SERVER_PORT}`);
    expect(TRUSTED_ORIGINS).toContain(`http://127.0.0.1:${SERVER_PORT}`);
  });

  it("trusts the base URL's own origin and never carries an empty entry", () => {
    expect(TRUSTED_ORIGINS).toContain(new URL(APP_BASE_URL).origin);
    // docker-compose passes TRUSTED_ORIGINS="" — that must not become [""]
    expect(TRUSTED_ORIGINS.every((o) => o.length > 0)).toBe(true);
  });

  describe("localOriginsFor", () => {
    it("skips wildcard bind hosts but keeps a concrete LAN/VPN host", () => {
      expect(localOriginsFor(3080, "0.0.0.0")).toEqual(["http://localhost:3080", "http://127.0.0.1:3080"]);
      expect(localOriginsFor(3080, "192.168.9.22")).toContain("http://192.168.9.22:3080");
    });

    it("brackets an IPv6 bind host the way URL syntax requires", () => {
      expect(localOriginsFor(3080, "::1")).toContain("http://[::1]:3080");
      expect(localOriginsFor(3080, "::")).not.toContain("http://[::]:3080");
    });

    it("adds the base URL origin and ignores a malformed one", () => {
      expect(localOriginsFor(3080, "127.0.0.1", "https://subshell.example:8443/x")).toContain(
        "https://subshell.example:8443",
      );
      expect(localOriginsFor(3080, "127.0.0.1", "not a url")).toEqual([
        "http://localhost:3080",
        "http://127.0.0.1:3080",
      ]);
    });

    it("does not trust the request host generally (the DNS-rebinding hole)", () => {
      // The rule is a static allowlist: nothing here marks "whatever Host the
      // request carried" as trusted, so a foreign name resolving to loopback
      // still needs an explicit TRUSTED_ORIGINS entry.
      expect(HOST).toBeTruthy();
      expect(localOriginsFor(3080, HOST).some((o) => o.includes("evil.example"))).toBe(false);
    });
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfig } from "@/commands/configure.js";

const made: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "subshell-apply-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("applyConfig", () => {
  it("writes the four owned keys with defaults for what was not given, and preserves foreign keys verbatim", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "BETTER_AUTH_SECRET=keepme\nSERVER_PORT=3080\n");
    const r = applyConfig({ port: "3090" }, d);
    expect(r.ok).toBe(true);
    const text = readFileSync(join(d, "config.env"), "utf8");
    expect(text).toContain("BETTER_AUTH_SECRET=keepme");
    expect(text).toContain("SERVER_PORT=3090");
    expect(text).toContain("HOST=0.0.0.0");
    expect(text).not.toContain("TRUSTED_ORIGINS=");
    if (r.ok) expect(r.changed).toEqual([{ key: "SERVER_PORT", from: "3080", to: "3090" }]);
  });

  it("refuses an invalid value with the key and the CLI's own reason, and writes nothing", () => {
    const d = dir();
    const r = applyConfig({ port: "70000" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "invalid") {
      expect(r.key).toBe("SERVER_PORT");
      expect(r.reason.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected an invalid-value refusal");
    }
    expect(() => readFileSync(join(d, "config.env"))).toThrow();
  });

  it("canonicalizes trusted origins, deletes the key when cleared, and warns on a LAN bind with a loopback base URL", () => {
    const d = dir();
    const first = applyConfig({ trustedOrigins: "HTTPS://Example.com:443/ , http://10.0.0.5:3080" }, d);
    expect(first.ok).toBe(true);
    expect(readFileSync(join(d, "config.env"), "utf8")).toContain(
      "TRUSTED_ORIGINS=https://example.com,http://10.0.0.5:3080",
    );
    if (first.ok) expect(first.warnings.some((w) => w.includes("loopback"))).toBe(true);
    const second = applyConfig({ trustedOrigins: "" }, d);
    expect(second.ok).toBe(true);
    expect(readFileSync(join(d, "config.env"), "utf8")).not.toContain("TRUSTED_ORIGINS");
  });

  /**
   * An unreadable file is a condition of the HOST, not of any submitted
   * value, so it must not be reported against a key — the SPA would render
   * "cannot read config.env" under the Port field, where nothing the person
   * types can fix it.
   */
  it("reports an unreadable config.env as its own kind, naming the file and not a key", () => {
    const d = dir();
    mkdirSync(join(d, "config.env")); // a directory where the file should be: EISDIR on read
    const r = applyConfig({ port: "3090" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "unreadable") {
      expect(r.path).toBe(join(d, "config.env"));
      expect(r.reason).toContain(join(d, "config.env"));
      expect(r).not.toHaveProperty("key");
    } else {
      throw new Error("expected an unreadable-file refusal");
    }
  });

  it("keeps a stored value the validator would refuse, so changing another key still works", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "TRUSTED_ORIGINS=https://*.example.com\n");
    const r = applyConfig({ port: "4000", trustedOrigins: "https://*.example.com" }, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.startsWith("TRUSTED_ORIGINS kept as found in"))).toBe(true);
      expect(r.changed).toEqual([{ key: "SERVER_PORT", from: undefined, to: "4000" }]);
    }
    expect(readFileSync(join(d, "config.env"), "utf8")).toContain("TRUSTED_ORIGINS=https://*.example.com");
  });
});

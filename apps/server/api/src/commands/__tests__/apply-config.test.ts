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

  /**
   * The LAN derivation (`services/lan-origins.ts`, 2026-09-17) means an
   * origin spelling one of this machine's OWN addresses is trusted with no
   * operator act at all, so the third warning speaks only of what is still
   * refused: NAMES the machine answers to that are not interface addresses.
   * The sentence it replaced — "a browser on any other machine sends an
   * origin this instance does not trust" — became false the day the probe
   * shipped, and a warning that cries 403 about a configuration that works
   * is how a warning stops being believed.
   */
  it("warns about names, not addresses, when a wildcard bind trusts only loopback spellings", () => {
    const d = dir();
    const r = applyConfig({ trustedOrigins: "http://localhost:5174" }, d);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // "nothing but loopback" is this warning's own opening — warning #1 also
    // carries the word "loopback", so the test names which warning it found.
    const w = r.warnings.find((m) => m.includes("nothing but loopback"));
    expect(w).toBeDefined();
    expect(w).toMatch(/this machine's own/i);
    expect(w).toMatch(/name/i);
    expect(w).not.toMatch(/does not trust/i);
    // The 403 is still what a browser dialing by name gets, and the key that
    // fixes it is still the whole point of saying so.
    expect(w).toContain("Invalid origin");
    expect(w).toContain("--trusted-origins");
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

/**
 * The third address warning (spec 2026-09-15 §4.2). Its configuration is the
 * one whose only symptom is a 403 naming nothing: the boot accepts it, the
 * server answers on the LAN, and every browser that is not on this box is
 * refused at sign-in with a message that names no key.
 */
describe("applyConfig — the LAN-bind sign-in warning", () => {
  it("fires on 0.0.0.0 + a loopback base URL + no trusted origins, and names both ways out", () => {
    const d = dir();
    const r = applyConfig({ host: "0.0.0.0", baseUrl: "http://localhost:3080", trustedOrigins: "" }, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warning = r.warnings.find((w) => w.includes("403"));
    expect(warning).toBeDefined();
    expect(warning).toContain("--trusted-origins");
    expect(warning).toContain("--base-url");
  });

  it("is silent once an origin is trusted — the list is what fixes it", () => {
    const d = dir();
    const r = applyConfig(
      { host: "0.0.0.0", baseUrl: "http://localhost:3080", trustedOrigins: "http://box.local:3080" },
      d,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes("403"))).toBe(false);
  });

  it("is silent on a loopback bind — nothing off this box can reach the server to be refused", () => {
    const d = dir();
    const r = applyConfig({ host: "127.0.0.1", baseUrl: "http://localhost:3080", trustedOrigins: "" }, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes("403"))).toBe(false);
  });

  it("is silent when the base URL is already the LAN address people browse", () => {
    const d = dir();
    const r = applyConfig({ host: "0.0.0.0", baseUrl: "http://box.local:3080", trustedOrigins: "" }, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes("403"))).toBe(false);
  });
});

/**
 * The LAN warning asks "is every configured origin loopback", not "is the list
 * empty". Review, 2026-09-15: an explicit `TRUSTED_ORIGINS=http://localhost:5174`
 * reaches a browser on another machine exactly as nothing does, and the CLI used
 * to stay silent on it while the dashboard's checklist flagged it — the two
 * disagreeing about a configuration both can see. The CLI was widened to match,
 * because the checklist was the more correct half.
 */
/**
 * C7 — the lost update. `applyConfig` reads, merges, and renames; two writers
 * (dashboard PATCH + CLI, or two PATCHes) can interleave so the second merge
 * runs against a stale read and silently reverts the first writer's changes
 * while BOTH audit rows claim success. The fix is a re-read and re-merge
 * against the FRESH content immediately before the rename; the tests drive it
 * through the `beforeReread` seam, which is the read→rename window itself.
 */
describe("applyConfig — concurrent writers", () => {
  it("a second write landing between the read and the rename survives — disjoint keys both stick", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "BETTER_AUTH_SECRET=keepme\nSERVER_PORT=3080\n");
    // Writer B lands after A's first read: it changes HOST and adds a foreign
    // key. A's stale read saw neither, and the old merge would have rewritten
    // the file from that stale map and silently reverted both.
    const r = applyConfig({ port: "3090" }, d, {
      beforeReread: () =>
        writeFileSync(
          join(d, "config.env"),
          "BETTER_AUTH_SECRET=keepme\nSERVER_PORT=3080\nHOST=127.0.0.1\nSOME_OTHER_TOOL=hello\n",
        ),
    });
    expect(r.ok).toBe(true);
    const text = readFileSync(join(d, "config.env"), "utf8");
    expect(text).toContain("SERVER_PORT=3090"); // A's intent
    expect(text).toContain("HOST=127.0.0.1"); // B's change, kept
    expect(text).toContain("SOME_OTHER_TOOL=hello"); // B's foreign key, kept
    expect(text).toContain("BETTER_AUTH_SECRET=keepme");
    if (r.ok) expect(r.changed).toEqual([{ key: "SERVER_PORT", from: "3080", to: "3090" }]);
  });

  it("truly-overlapping keys still clobber, per-key last-writer-wins — only that key", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "SERVER_PORT=3080\nDATABASE_PATH=/var/db/old.db\n");
    // A names port AND host; B (mid-A) rewrites port too. A renames last, so
    // A wins the overlap — but B's DATABASE_PATH must NOT ride A's stale map.
    const r = applyConfig({ port: "3090", host: "0.0.0.0" }, d, {
      beforeReread: () => writeFileSync(join(d, "config.env"), "SERVER_PORT=4100\nDATABASE_PATH=/var/db/new.db\n"),
    });
    expect(r.ok).toBe(true);
    const text = readFileSync(join(d, "config.env"), "utf8");
    expect(text).toContain("SERVER_PORT=3090"); // overlap: this writer won
    expect(text).toContain("DATABASE_PATH=/var/db/new.db"); // B's key survived
    if (r.ok) {
      expect(r.changed).toContainEqual({ key: "SERVER_PORT", from: "4100", to: "3090" });
      expect(r.changed).toContainEqual({ key: "HOST", from: undefined, to: "0.0.0.0" });
    }
  });

  it("a file vanished between the reads falls to the original empty-merge path", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "SERVER_PORT=3080\n");
    const r = applyConfig({ port: "3090" }, d, {
      beforeReread: () => rmSync(join(d, "config.env")),
    });
    expect(r.ok).toBe(true);
    const text = readFileSync(join(d, "config.env"), "utf8");
    expect(text).toContain("SERVER_PORT=3090");
    expect(text).toContain("HOST=0.0.0.0"); // defaults, as on a fresh install
    if (r.ok) expect(r.changed).toEqual([{ key: "SERVER_PORT", from: undefined, to: "3090" }]);
  });

  it("no concurrent write changes nothing observable — the unchanged fast path", () => {
    const d = dir();
    writeFileSync(join(d, "config.env"), "BETTER_AUTH_SECRET=keepme\nSERVER_PORT=3080\n");
    const r = applyConfig({ port: "3090" }, d, { beforeReread: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toEqual([{ key: "SERVER_PORT", from: "3080", to: "3090" }]);
      expect(r.values.SERVER_PORT).toBe("3090");
    }
  });
});

describe("the LAN-bind warning and an explicitly loopback origin list", () => {
  it("warns when every configured origin is loopback, not only when none is set", () => {
    const r = applyConfig(
      { host: "0.0.0.0", baseUrl: "http://localhost:3080", trustedOrigins: "http://localhost:5174" },
      dir(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join("\n")).toContain("403");
  });

  it("stays silent once ONE reachable origin is configured", () => {
    const r = applyConfig(
      {
        host: "0.0.0.0",
        baseUrl: "http://localhost:3080",
        trustedOrigins: "http://localhost:5174,http://192.168.1.5:3080",
      },
      dir(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join("\n")).not.toContain("403");
  });
});

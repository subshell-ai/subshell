import { describe, expect, it } from "bun:test";
import { ForbiddenError, requirePerm } from "@/api/auth-guard.js";

/**
 * The bearer permission map grows a `prompts` resource (spec 2026-09-28).
 * The two rules this suite pins are the gate itself and the one
 * backward-compat concession: a map minted BEFORE the feature carries
 * `channels` but no `prompts` key, and self-extension never re-mints it,
 * so absence predates the gate rather than declining it.
 */
describe("requirePerm: prompts scope", () => {
  it("cookie and system-key actors pass unconditionally", () => {
    for (const actor of ["cookie", "system-key"] as const) {
      requirePerm({ actor, apiKeyPermissions: null }, "prompts", "read");
      requirePerm({ actor, apiKeyPermissions: null }, "prompts", "write");
    }
  });

  it("a pre-prompts subshell map (channels+subshells, no prompts key) passes", () => {
    const legacy = { channels: ["read", "write"], subshells: ["read", "write"] };
    requirePerm({ actor: "subshell-key", apiKeyPermissions: legacy }, "prompts", "read");
    requirePerm({ actor: "subshell-key", apiKeyPermissions: legacy }, "prompts", "write");
  });

  it("a map that carries the prompts key is honored verbatim", () => {
    const readOnly = { channels: ["read"], subshells: ["read"], prompts: ["read"] };
    requirePerm({ actor: "subshell-key", apiKeyPermissions: readOnly }, "prompts", "read");
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: readOnly }, "prompts", "write")).toThrow(
      ForbiddenError,
    );
  });

  it("an unrecognizable map (no channels key) does NOT ride the legacy pass", () => {
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: {} }, "prompts", "read")).toThrow(
      ForbiddenError,
    );
  });

  it("channels and subshells keep their old strictness", () => {
    const readOnly = { channels: ["read"], subshells: ["read"], prompts: ["read"] };
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: readOnly }, "channels", "write")).toThrow(
      ForbiddenError,
    );
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: readOnly }, "subshells", "write")).toThrow(
      ForbiddenError,
    );
  });
});

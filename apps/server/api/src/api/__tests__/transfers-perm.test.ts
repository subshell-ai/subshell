import { describe, expect, it } from "bun:test";
import { ForbiddenError, requirePerm } from "@/api/auth-guard.js";

/**
 * The bearer permission map grows a `transfers` resource (spec 2026-10-01
 * §5). The rule this suite pins is the ABSENCE of a concession: the
 * `prompts` legacy pass (spec 2026-09-28) is a one-off historical carve-out
 * for a text library, and grandfathering pre-feature tokens into a file-move
 * grant is exactly the mistake it would be to COPY. A map without the
 * `transfers` key therefore 403s transfers, however otherwise complete it
 * looks - until the pane restarts and re-mints.
 */
describe("requirePerm: transfers scope", () => {
  it("cookie and system-key actors pass unconditionally", () => {
    for (const actor of ["cookie", "system-key"] as const) {
      requirePerm({ actor, apiKeyPermissions: null }, "transfers", "write");
      requirePerm({ actor, apiKeyPermissions: {} }, "transfers", "write");
    }
  });

  it("a pre-feature map (channels/subshells/prompts, NO transfers) is refused", () => {
    const preFeature = { channels: ["read", "write"], subshells: ["read", "write"], prompts: ["read", "write"] };
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: preFeature }, "transfers", "read")).toThrow(
      ForbiddenError,
    );
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: preFeature }, "transfers", "write")).toThrow(
      ForbiddenError,
    );
    // Same map, same check, the PROMPTS resource still passes on its own
    // concession - proving the refusal names transfers, not the map shape.
    requirePerm({ actor: "subshell-key", apiKeyPermissions: preFeature }, "prompts", "write");
  });

  it("a minted map passes per its grants", () => {
    const full = { transfers: ["read", "write"] };
    requirePerm({ actor: "subshell-key", apiKeyPermissions: full }, "transfers", "read");
    requirePerm({ actor: "subshell-key", apiKeyPermissions: full }, "transfers", "write");
    const readOnly = { transfers: ["read"] };
    requirePerm({ actor: "subshell-key", apiKeyPermissions: readOnly }, "transfers", "read");
    expect(() => requirePerm({ actor: "subshell-key", apiKeyPermissions: readOnly }, "transfers", "write")).toThrow(
      ForbiddenError,
    );
  });
});

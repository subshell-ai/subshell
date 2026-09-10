import { describe, expect, it } from "bun:test";
import { derivePluginId, isSafePluginId, parseNpmSpec } from "@/lib/plugin-spec";

/**
 * The npm-spec reading the install-by-name field does. These helpers suggest
 * a plugin id, they decide nothing (the server verifies the suggestion
 * against the package's manifest and refuses a mismatch) — so what is pinned
 * here is the suggestion rule, including where it abstains.
 */
describe("parseNpmSpec", () => {
  it("splits the range only at a non-leading @", () => {
    expect(parseNpmSpec("pi")).toEqual({ name: "pi" });
    expect(parseNpmSpec("@acme/plugin-thing")).toEqual({ name: "@acme/plugin-thing" });
    expect(parseNpmSpec("@acme/plugin-thing@1.2.0")).toEqual({ name: "@acme/plugin-thing", range: "1.2.0" });
    expect(parseNpmSpec("pi@latest")).toEqual({ name: "pi", range: "latest" });
  });

  it("leaves a dangling @ in the name for the server's parser to refuse", () => {
    expect(parseNpmSpec("pi@")).toEqual({ name: "pi@" });
  });
});

describe("derivePluginId", () => {
  it("follows the published convention: scope and plugin- prefix dropped", () => {
    expect(derivePluginId("@subshell-ai/plugin-pi")).toBe("pi");
    expect(derivePluginId("@subshell-ai/plugin-claude-code@1.0.0")).toBe("claude-code");
    expect(derivePluginId("plugin-pi")).toBe("pi");
    expect(derivePluginId("e2e-demo@1.0.0")).toBe("e2e-demo");
  });

  it("abstains when the slug is not a usable plugin id", () => {
    // A leading hyphen or a name with uppercase cannot be a directory name;
    // the server would answer 400, and the field asks for the id instead.
    expect(derivePluginId("@acme/plugin-Pi")).toBeUndefined();
    expect(derivePluginId("plugin-")).toBeUndefined();
    expect(derivePluginId("@acme/@broken")).toBeUndefined();
    expect(derivePluginId("@no-slash")).toBeUndefined();
  });

  it("never returns an id the route would refuse", () => {
    for (const spec of ["pi", "@subshell-ai/plugin-pi@2.0.0", "a".repeat(80)]) {
      const id = derivePluginId(spec);
      if (id !== undefined) expect(isSafePluginId(id)).toBe(true);
    }
  });
});

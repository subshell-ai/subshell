import { describe, expect, it } from "bun:test";
import { builtInIds, readBuiltIn } from "../builtin-source.js";
import { allHarnesses } from "../index.js";

/**
 * A missing harness is only useful if the UI can say how to get it, so every
 * built-in AGENT HARNESS must carry a real install hint (registry-wide guard:
 * a new plugin without one fails here).
 *
 * Scoped by manifest type, not id, because the exemption is a property of the
 * kind: a `terminal` plugin has nothing to install (the terminal plugin's
 * binary IS the user's login shell), so demanding a hint would demand a lie.
 * An agent harness that forgets its install block still fails here.
 */
describe("install hints", () => {
  it("every built-in agent harness ships an install command and docs url", async () => {
    expect(allHarnesses().length).toBeGreaterThan(0);
    let harnessesChecked = 0;
    for (const id of await builtInIds()) {
      const plugin = await readBuiltIn(id);
      if (plugin?.manifest.type !== "agent-harness") continue;
      harnessesChecked++;
      const install = plugin.manifest.install;
      expect(install?.command, id).toMatch(/^(curl|npm|bun|brew|winget)/);
      expect(install?.command, id).toContain("http");
      expect(install?.docsUrl, id).toMatch(/^https:\/\//);
    }
    expect(harnessesChecked).toBe(5);
  });
});

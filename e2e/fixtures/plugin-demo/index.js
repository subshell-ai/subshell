/**
 * The e2e fixture plugin's entry — a plain-JS mirror of
 * `packages/plugins/pi/src/index.ts`'s export shape: a default-exported
 * factory that takes the host object and returns the plugin. No tsconfig, no
 * build step: the fake registry (stack.ts) packs THIS directory with
 * `bun pm pack` and serves the tgz, so these bytes must survive
 * pane-runtime's load-check as they are — the loader calls the factory and
 * requires `buildCommand`, `validateProfile` and `capabilities` on the
 * result (plugin-runtime.ts). It is never launched; no harness binary exists
 * for this id, and spec 14 only installs, reports, and removes it.
 *
 * `subshell.description` and the top-level `license` are not decoration:
 * parseManifest (@subshell-ai/plugin-api) REFUSES a manifest whose subshell
 * block has no description string, so this fixture carries one like every
 * real plugin does.
 */
const createPlugin = (_host) => ({
  // Nothing declared means nothing to mismatch: `capabilities()` is validated
  // against the members present at load, and the empty set is the honest
  // answer for a factory that implements only the three required members.
  capabilities: () => [],

  buildCommand: (input) => [input.binary],

  validateProfile: (profile) => {
    const issues = [];
    if (!profile?.name || String(profile.name).trim().length === 0) {
      issues.push({ field: "name", message: "Profile name is required." });
    }
    return { valid: issues.length === 0, issues };
  },
});

export default createPlugin;

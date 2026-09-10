/**
 * The small npm-spec reading the install-by-name field needs. It never
 * DECIDES anything about an install: the server is the authority (its
 * `installPlugin` checks the package's declared id against the one sent, and
 * refuses a mismatch by naming both). These helpers only let the page ask the
 * server's question in the form the route accepts — a safe plugin id next to
 * the spec.
 */

/** The shape a plugin id may take (mirrors the route's SAFE_PLUGIN_ID; ids become directory names). */
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when `id` is a plugin id the route will accept. */
export function isSafePluginId(id: string): boolean {
  return SAFE_PLUGIN_ID.test(id);
}

/**
 * Splits a typed npm spec into package name and version range
 * (`@scope/pkg@1.2.0` → `{name:"@scope/pkg", range:"1.2.0"}`). A leading
 * `@` is scope, never a range, and an empty range (`pkg@`) is left in the
 * NAME so the server's own parser is the one that refuses it.
 */
export function parseNpmSpec(spec: string): { name: string; range?: string } {
  const at = spec.lastIndexOf("@");
  if (at > 0 && at + 1 < spec.length) {
    return { name: spec.slice(0, at), range: spec.slice(at + 1) };
  }
  return { name: spec };
}

/**
 * The plugin id a package name SUGGESTS: scope dropped, leading `plugin-`
 * dropped (`@subshell-ai/plugin-pi` → `pi`, `plugin-pi` → `pi`, `pi` → `pi`).
 * This is the convention the published built-ins follow, not a fact the
 * browser can know — a package may declare any id — which is exactly why the
 * install POST asserts it and the server verifies it. Undefined when the
 * slug is not a usable id, and then the operator names the id themselves.
 */
export function derivePluginId(spec: string): string | undefined {
  const { name } = parseNpmSpec(spec);
  const slash = name.indexOf("/");
  // A leading-@ name with no slash is a malformed spec, not a scope: leave it
  // for the server's parser to refuse rather than inventing a slug from it.
  const unscoped = name.startsWith("@") && slash !== -1 ? name.slice(slash + 1) : name;
  const slug = unscoped.startsWith("plugin-") ? unscoped.slice("plugin-".length) : unscoped;
  return isSafePluginId(slug) ? slug : undefined;
}

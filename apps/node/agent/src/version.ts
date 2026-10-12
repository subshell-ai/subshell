import pkg from "../package.json" with { type: "json" };

/**
 * The agent's own version, sourced from package.json (the single source of
 * truth). resolveJsonModule lets tsc type it, Bun's bundler inlines it for
 * both tsdown and `bun build --compile`. The `with { type: "json" }` attribute
 * is what the `@internal/server` typecheck needs: its tests import the agent's
 * modules in place under NodeNext, which requires the attribute on a JSON
 * import - the spelling the server's own version.ts and this package's
 * release script already use.
 */
export const NODE_VERSION: string = pkg.version;

import pkg from "../package.json" with { type: "json" };

/**
 * The server's own version, sourced from package.json (the single source of
 * truth — same pattern as the client's `version.ts`). resolveJsonModule types
 * it, and Bun's bundler inlines it for `bun build --compile`, so the compiled
 * binary answers `version` with no filesystem read.
 */
export const SERVER_VERSION: string = pkg.version;

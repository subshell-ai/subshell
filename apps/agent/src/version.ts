import pkg from "../package.json";

/**
 * The agent's own version, sourced from package.json (the single source of
 * truth). resolveJsonModule lets tsc type it, Bun's bundler inlines it for
 * both tsdown and `bun build --compile`.
 */
export const AGENT_VERSION: string = pkg.version;

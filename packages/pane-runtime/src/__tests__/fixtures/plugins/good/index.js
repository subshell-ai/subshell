/** A minimal valid plugin. `buildCommand` proves the host object is reachable. */
export default (host) => ({
  buildCommand: (input) => [input.binary, host.shellQuote("a b")],
  validatePreset: () => ({ valid: true, issues: [] }),
  capabilities: () => [],
});

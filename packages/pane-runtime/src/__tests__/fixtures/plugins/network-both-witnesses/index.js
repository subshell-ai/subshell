/**
 * `publishImplicit: true` says the publish leaves no daemon witness — the
 * host's record is the published state. `supervisedProcess` says the opposite
 * shape — the host's child IS the daemon, and its running is the witness.
 * Declaring both gives the host two merges that can disagree (record present,
 * child parked), so the loader refuses the contradiction.
 */
export default () => ({
  capabilities: () => ["publish", "supervise"],
  status: async () => ({ state: "joined", addresses: [], hints: [] }),
  join: async () => ({ state: "joined" }),
  leave: async () => {},
  publish: async () => ({ addresses: [] }),
  unpublish: async () => {},
  supervisedProcess: () => null,
});

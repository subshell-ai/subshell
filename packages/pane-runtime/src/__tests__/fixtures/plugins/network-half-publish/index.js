/**
 * Declares `publish` while implementing only half of the pair. A publish
 * nothing can undo would leave a server exposed with no way back, so the
 * loader must refuse this rather than load it.
 */
export default () => ({
  capabilities: () => ["publish"],
  status: async () => ({ state: "joined", addresses: [], hints: [] }),
  join: async () => ({ state: "joined" }),
  leave: async () => {},
  publish: async () => ({ addresses: [] }),
});

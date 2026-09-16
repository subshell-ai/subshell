/**
 * A public exposure with no `requestGuard`. The host refuses to publish or to
 * arm this anyway; the loader refuses it outright so the refusal arrives at
 * install time rather than the first time an admin presses publish.
 */
export default () => ({
  capabilities: () => ["publish"],
  status: async () => ({ state: "joined", addresses: [], hints: [] }),
  join: async () => ({ state: "joined" }),
  leave: async () => {},
  publish: async () => ({ addresses: [] }),
  unpublish: async () => {},
});

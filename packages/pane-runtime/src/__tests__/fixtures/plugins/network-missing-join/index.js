/** Required members minus `join`, so the loader must refuse it BY NAME. */
export default () => ({
  capabilities: () => [],
  status: async () => ({ state: "joined", addresses: [], hints: [] }),
  leave: async () => {},
});

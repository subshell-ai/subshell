/** A minimal valid NETWORK plugin: the four required members and nothing else. */
export default (host) => ({
  capabilities: () => [],
  status: async (ctx) => ({
    state: "joined",
    // Proves both that the host object is reachable and that the port arrives
    // from the context rather than from anything the plugin remembered.
    addresses: [{ url: `http://fixture:${ctx.port}`, scheme: "http", label: host.platform, secureContext: false }],
    hints: [],
  }),
  join: async () => ({ state: "joined" }),
  leave: async () => {},
});

/**
 * `publishImplicit: true` means JOIN alone makes the addresses answer — the
 * host records and trusts them without any vendor act. With a
 * `public-with-gate` exposure that combination describes a server that goes
 * publicly reachable on the open internet from a bare join, before any
 * publish press exists to warn about it. The loader refuses the pair; the
 * guard fixture passes (a `requestGuard` IS implemented) so this refusal,
 * not that one, is what fails the load.
 */
export default () => ({
  capabilities: () => ["publish", "guard"],
  status: async () => ({ state: "joined", addresses: [], hints: [] }),
  join: async () => ({ state: "joined" }),
  leave: async () => {},
  publish: async () => ({ addresses: [] }),
  unpublish: async () => {},
  requestGuard: () => ({ kind: "cloudflare-access", hostname: "x.example", teamDomain: "t", aud: "a" }),
});

/**
 * Version comparison and the agent floor, shared by the control plane, the
 * agent and the release pipelines.
 *
 * Pure by design — no `node:` imports — because the barrel this is exported
 * from is consumed by the mobile app through Metro, which cannot resolve
 * them. That is also why it lives here rather than in `release-artifacts.ts`,
 * where the comparator started: that module reads the filesystem and is
 * deliberately kept out of the barrel.
 */

/**
 * Compare `a` vs `b` numerically over the dotted-numeric prefix.
 *
 * Suffixes are ignored: a `-canary` tag never makes a build OLDER than its
 * floor, which is the behaviour every caller wants — a prerelease of the
 * required version satisfies the requirement.
 *
 * @param a - version to test
 * @param b - version to compare against
 * @returns True when `a` is strictly older than `b`
 */
export function semverLt(a: string, b: string): boolean {
  const nums = (v: string) => (v.match(/^\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const [av, bv] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * The oldest agent this control plane will talk to.
 *
 * The OPERATOR-FACING half of version compatibility, and the one a person can
 * act on: "this server needs subshell >= X, you are running Y, update it"
 * names both the problem and the remedy, where a bare protocol mismatch names
 * neither. The wire contract is still {@link NODE_PROTOCOL_VERSION}, checked
 * as a backstop — an agent at or above this floor should always speak it, and
 * if it does not, the floor is set wrong.
 *
 * Raise this in the same commit that bumps the protocol, so the refusal an
 * operator sees always tells them the version to install.
 *
 * And raise `apps/node/agent/package.json` to the SAME value in that commit.
 * `AGENT_VERSION` is that field, so a floor above it makes HEAD refuse a node
 * built from HEAD — the server and the agent ship together, and for the
 * window before the version PR lands there would be no agent that satisfies
 * its own server. (Changesets then releases the client one patch above the
 * floor, which passes; do not use a `minor` changeset on top of a hand-raised
 * version or the released client lands two versions clear of the floor for
 * nothing.)
 *
 * Reset to 0.1.0 on 2026-09-07 along with every app version, when the release
 * history was cleared and the whole fleet re-cut from 0.1.0. The old 0.4.0
 * floor described versions that no longer exist; the wire contract that
 * actually gates nodes is still NODE_PROTOCOL_VERSION.
 *
 * Raised to 0.5.0 with protocol 7 (the preset rename, spec 2026-09-13), the
 * same commit hand-raising `apps/node/agent/package.json` to 0.5.0 — the
 * rule above, followed.
 *
 * Raised to 0.6.0 with protocol 8 (node maintenance, spec 2026-09-14), the
 * same way. An agent below this speaks no `set_maintenance`, so the plane
 * could set a flag that machine would never honour — the floor is what turns
 * that into "update the agent" instead of a launch that quietly proceeds.
 *
 * Raised to 0.7.0 with protocol 9 (`service.linger`), the same way. An agent
 * below this reports no linger fact, and the surface that reads it would have
 * to render "unknown" for a machine that simply predates the field — an
 * answer indistinguishable from logind refusing to say.
 *
 * Raised to 0.9.0 with protocol 10 (the `update` command, spec 2026-09-15),
 * the same way — 0.8.0 is the version currently published, so the floor goes
 * one minor above it rather than to it. An agent below this speaks no
 * `update`, which is the one thing a refused agent must be able to hear: the
 * plane HOLDS such a socket instead of closing it (§5.3) and can still send
 * the command, and an agent too old to know it answers `unsupported`, which
 * the route turns into "update this node by hand: `subshell update`".
 *
 * Raised to 0.11.0 with protocol 12 (the signed `update`, spec 2026-09-17
 * §6), the same way — `apps/node/agent/package.json` goes to 0.11.0 in the
 * same commit, and the release changesets the agent ONE patch above the
 * floor (0.11.1), not two. An agent below this speaks no signature check:
 * it would install whatever digest a commanding plane names, which is the
 * exact silent-downgrade the protocol bump exists to make impossible — so
 * the floor and {@link NODE_SIGNED_UPDATES_PROTOCOL_VERSION} tell one story,
 * and until the matching `cli-node-v*` cut publishes, held-node copy is what
 * explains the gap to the operator.
 */
export const MIN_NODE_VERSION = "0.11.0";

/**
 * Whether an agent reporting `version` may connect.
 *
 * An unparseable or absent version reads as 0 and is refused — a build that
 * cannot say what it is cannot be assumed current.
 *
 * @param version - the agent's self-reported `agentVersion` from `ready`
 * @returns True when the agent is at or above {@link MIN_NODE_VERSION}
 */
export function nodeVersionSupported(version: string | null | undefined): boolean {
  return typeof version === "string" && !semverLt(version, MIN_NODE_VERSION);
}

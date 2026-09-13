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
 */
export const MIN_AGENT_VERSION = "0.5.0";

/**
 * Whether an agent reporting `version` may connect.
 *
 * An unparseable or absent version reads as 0 and is refused — a build that
 * cannot say what it is cannot be assumed current.
 *
 * @param version - the agent's self-reported `agentVersion` from `ready`
 * @returns True when the agent is at or above {@link MIN_AGENT_VERSION}
 */
export function agentVersionSupported(version: string | null | undefined): boolean {
  return typeof version === "string" && !semverLt(version, MIN_AGENT_VERSION);
}

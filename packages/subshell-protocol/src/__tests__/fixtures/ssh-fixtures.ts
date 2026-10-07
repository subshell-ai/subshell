/**
 * Shared SSH fixtures (Gate A, pruned with the destination product by
 * Workstream C: the run/terminal/test/control factories deleted with their
 * wire arms). Workstreams B, C, D and G build their suites
 * from THESE factories rather than hand-rolling frames: a fixture that stops
 * parsing is a contract break caught in the protocol package, not four silent
 * drifts downstream. Every factory returns the WIRE type (plain data), every
 * "boundary" export is the exact legal extreme, and `invalidSnapshotVariants`
 * is the adversarial set the node-side validator must refuse - one member per
 * absent-forbidden field plus the hygiene refusals.
 *
 * Pure data + spread overrides; imports nothing from `bun:test` so production
 * code could (but should not) share it.
 */

import type { SshConnectionSnapshotWire, SshHopWire } from "../../ssh-config.js";
import type { SshErrorCode } from "../../ssh-errors.js";
import type { SshDiscoverAliasesCommand, SshResolveConfigCommand } from "../../ssh-frames.js";
import { SSH_MAX_IDENTITY_REFS, SSH_MAX_PROXY_HOPS } from "../../ssh-limits.js";
import type { NodeSshAliasListResult, NodeSshResolveOutcomeWire } from "../../ssh-results.js";

/** A well-formed hop (fixture arg for chains). */
export function makeHop(n = 0): SshHopWire {
  return { host: `jump-${n}.example.net`, user: n % 2 === 0 ? `jumpuser${n}` : null, port: 22 };
}

/** The canonical approved snapshot: two identities, an agent, two known-hosts files, one hop. */
export function makeSnapshot(overrides: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire {
  return {
    alias: "app02",
    host: "app-02.example.net",
    user: "deploy",
    port: 22,
    identityFiles: ["/home/deploy/.ssh/id_ed25519", "/home/deploy/.ssh/deploy_key"],
    certificateFiles: ["/home/deploy/.ssh/id_ed25519-cert.pub"],
    authAgentSocket: "/run/user/1000/ssh-agent.sock",
    knownHostsFiles: ["/home/deploy/.ssh/known_hosts", "/etc/ssh/ssh_known_hosts"],
    hostKeyAlias: null,
    proxyJumps: [makeHop(0)],
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
    ...overrides,
  };
}

/**
 * An invalid snapshot per forbidden field, with a realistic offending value.
 * The node validator must refuse EVERY entry here, and the resolve/UI story
 * must be able to name which field blocked.
 */
export function invalidSnapshotVariants(): { field: string; snapshot: Record<string, unknown> }[] {
  const base = makeSnapshot();
  return [
    { field: "proxyCommand", snapshot: { ...base, proxyCommand: "nc proxy 8443" } },
    { field: "forwards", snapshot: { ...base, forwards: "LocalForward 9000 socks" } },
    { field: "tunnels", snapshot: { ...base, tunnels: "yes" } },
    { field: "localCommands", snapshot: { ...base, localCommands: "notify-send up" } },
    { field: "remoteCommand", snapshot: { ...base, remoteCommand: "sh -i" } },
    { field: "sendEnv", snapshot: { ...base, sendEnv: "LANG LC_*" } },
    { field: "setEnv", snapshot: { ...base, setEnv: "FOO=bar" } },
    { field: "escapes", snapshot: { ...base, escapes: "~C" } },
  ];
}

/** Hygiene violations the snapshot parser must refuse (beyond the forbidden members). */
export function invalidSnapshotHygieneVariants(): { field: string; snapshot: Record<string, unknown> }[] {
  const base = makeSnapshot();
  return [
    { field: "optionLikeHost", snapshot: { ...base, host: "-oProxyCommand=touch_pwned" } },
    { field: "controlCharUser", snapshot: { ...base, user: "deploy\x00" } },
    { field: "relativeIdentity", snapshot: { ...base, identityFiles: [".ssh/id_ed25519"] } },
    { field: "zeroPort", snapshot: { ...base, port: 0 } },
    {
      field: "overMaxHops",
      snapshot: { ...base, proxyJumps: Array.from({ length: SSH_MAX_PROXY_HOPS + 1 }, (_, i) => makeHop(i)) },
    },
    {
      field: "identityListTooLong",
      snapshot: {
        ...base,
        identityFiles: Array.from({ length: SSH_MAX_IDENTITY_REFS + 1 }, (_, i) => `/home/deploy/.ssh/id_${i}`),
      },
    },
    { field: "missingUserKey", snapshot: Object.fromEntries(Object.entries(base).filter(([k]) => k !== "user")) },
  ];
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/** The one input-free command, spelled for census loops. */
export function makeDiscoverAliases(): SshDiscoverAliasesCommand {
  return { type: "ssh_discover_aliases" };
}

export function makeResolveConfig(overrides: Partial<SshResolveConfigCommand> = {}): SshResolveConfigCommand {
  return { type: "ssh_resolve_config", alias: "app02", ...overrides };
}

export function makeAliasList(overrides: Partial<NodeSshAliasListResult> = {}): NodeSshAliasListResult {
  return { aliases: ["app01", "app02", "staging"], includeCycle: false, truncated: false, ...overrides };
}

export function makeResolveOk(snapshot = makeSnapshot()): NodeSshResolveOutcomeWire {
  return { accepted: true, snapshot };
}

export function makeResolveRefused(
  code: SshErrorCode = "unsupported_setting",
  settings = ["ProxyCommand"],
): NodeSshResolveOutcomeWire {
  return { accepted: false, code, settings };
}

/**
 * The user-declared port-forward row (docs/superpowers/specs/2026-10-15-ssh-port-forwards-design.md).
 *
 * Read the sibling `ssh-config.ts` first, because the two grammars draw the
 * line the security posture depends on: the SNAPSHOT's forbidden `forwards`
 * member stays literal null, so a forward found in the connecting account's
 * own ssh config still fails resolution by name. What lives HERE is the other
 * door - a row the human typed into the launch form (or a preset saved from
 * it), approved on its face, rendered into the per-connection config's exact
 * destination block. Same rebuild discipline as `parseSshConnectionSnapshot`:
 * any bad row refuses the whole list, because half a list of approved
 * forwards is a lie about what the user approved.
 *
 * Shape is the grammar's job; policy is the plane's. `bindHost` may name ANY
 * canonical host here, including `0.0.0.0`: whether a wide bind is ALLOWED is
 * the connecting node's `sshWideForwards` decision, checked at the launch
 * route against the machine's setting, never here. This module only knows
 * what a row IS, so the node can re-validate the shape it was handed without
 * holding the plane's policy.
 *
 * Imports no `node:` builtin; Metro-safe barrel like its neighbors.
 */

import { isRecord, isStr } from "./guards.js";
import { isSshHostName, isSshPort } from "./ssh-config.js";

/** The three OpenSSH forward kinds: `-L`, `-R`, `-D`. */
export const SSH_FORWARD_KINDS = ["local", "remote", "dynamic"] as const;

/** One member of {@link SSH_FORWARD_KINDS}. */
export type SshForwardKind = (typeof SSH_FORWARD_KINDS)[number];

/** True when `value` is one of the named kinds (case-sensitive: the wire spells enums, never prose). */
export function isSshForwardKind(value: unknown): value is SshForwardKind {
  return isStr(value) && (SSH_FORWARD_KINDS as readonly string[]).includes(value);
}

/**
 * One approved forward. The listen end is where the port binds: on the
 * connecting machine B for `local`/`dynamic`, on the destination D for
 * `remote`. The target is what traffic reaches: a host D can see for
 * `local`, a host B can see for `remote`, nothing at all for `dynamic`
 * (the SOCKS channel picks its own destinations at runtime, which is the
 * whole feature and exactly the reach a shell on D already grants).
 *
 * A `type`, not an interface: rows ride inside JSON command members, and a
 * type has an implicit index signature the command builders rely on.
 */
export type SshForwardWire = {
  /** Which way traffic flows; see {@link SshForwardKind}. */
  kind: SshForwardKind;
  /** Listen port, 1..65535. Always explicit: an ephemeral/auto port has no honest audit story (spec §10). */
  listenPort: number;
  /**
   * Listen bind host; null means "the stack's loopback default" (rendered
   * explicitly for local/dynamic; for remote, D's own `GatewayPorts` policy
   * decides, which is D's to make - spec §6). Grammar-valid host otherwise;
   * the WIDE question is the plane's gate, not this parser's.
   */
  bindHost: string | null;
  /** Target host; required for local/remote, null only for dynamic. */
  targetHost: string | null;
  /** Target port; follows the same kind rule. */
  targetPort: number | null;
};

/**
 * Rows one connection may carry. Generous for a real dev host (a database, a
 * cache, an admin API, and room to spare) and small enough that the audit
 * summary and the rendered block stay reviewable. Over the cap is a refusal,
 * never a truncation.
 */
export const SSH_MAX_FORWARD_ROWS = 16;

/**
 * The sentence every station says when {@link parseSshForwardRows} refuses a
 * list. Shared so the launch's 400 and the preset save's 400 cannot drift;
 * the web form mirrors the same rules in its own per-field copy.
 */
export const SSH_FORWARD_LIST_REFUSAL =
  "That port-forward list isn't valid. Each forward needs a kind (local, remote, or dynamic), a listen port from 1 to 65535, and a target host and port except for dynamic. Two forwards can't bind the same port on the same machine.";

/** The keys one row may spell; anything else means the caller hand-built a shape this grammar does not have. */
const FORWARD_ROW_KEYS: readonly (keyof SshForwardWire)[] = [
  "kind",
  "listenPort",
  "bindHost",
  "targetHost",
  "targetPort",
];

/**
 * Validate and rebuild one row. Returns the narrowed row or null; the caller
 * never sees the input object (rebuilt output, stray keys die with the input,
 * same discipline as the snapshot parser).
 */
function parseSshForwardRow(value: unknown): SshForwardWire | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!(FORWARD_ROW_KEYS as readonly string[]).includes(key)) return null;
  }
  if (!isSshForwardKind(value.kind) || !isSshPort(value.listenPort)) return null;
  if (!("bindHost" in value)) return null;
  if (value.bindHost !== null && !isSshHostName(value.bindHost)) return null;
  const needsTarget = value.kind === "local" || value.kind === "remote";
  if (needsTarget) {
    if (!("targetHost" in value) || !isSshHostName(value.targetHost)) return null;
    if (!("targetPort" in value) || !isSshPort(value.targetPort)) return null;
  } else {
    // A dynamic row carrying a target is a contradiction, not a hint: refuse.
    if ((value.targetHost ?? null) !== null || (value.targetPort ?? null) !== null) return null;
  }
  return {
    kind: value.kind,
    listenPort: value.listenPort,
    bindHost: value.bindHost === undefined ? null : (value.bindHost as string | null),
    targetHost: needsTarget ? (value.targetHost as string) : null,
    targetPort: needsTarget ? (value.targetPort as number) : null,
  };
}

/**
 * Validate a whole forward list: each row through {@link parseSshForwardRow},
 * then the LIST rules. A duplicate listen end refuses the list: two rows
 * competing for one bind on one machine is a bug the user should hear about,
 * not a race ssh silently half-wins. The listen end is keyed per SIDE: local
 * and dynamic rows bind on the connecting machine, remote rows on the
 * destination, so the same port spelled once on each side is two listeners,
 * not a dupe. The cap is a refusal too, never a trim.
 *
 * @param value - candidate rows (parsed JSON; unknown provenance), or null/undefined for "no forwards"
 * @returns the narrowed rows (possibly empty), or null when malformed or over cap
 */
export function parseSshForwardRows(value: unknown): SshForwardWire[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > SSH_MAX_FORWARD_ROWS) return null;
  const rows: SshForwardWire[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = parseSshForwardRow(item);
    if (row === null) return null;
    // The listen end is per SIDE: a local/dynamic row binds B, a remote row
    // binds D, so one port on each side is two listeners. Casefold only the
    // name: hostnames match case-insensitively, and "LOCALHOST" beside
    // "localhost" is one bind, not two. A null bind on a local/dynamic row is
    // canonically ssh's loopback, which is what the renderer spells as
    // `127.0.0.1`, so it DUPLICATES a written `127.0.0.1` rather than riding
    // beside it; two different literal names on one port ("localhost" vs
    // "127.0.0.1") stay a configuration ssh reports itself. A remote null
    // renders bare (D's GatewayPorts policy picks the address), which is a
    // different listen spec from any named bind, so it keys empty.
    const side = row.kind === "remote" ? "D" : "B";
    const bindKey = (row.kind === "remote" ? (row.bindHost ?? "") : (row.bindHost ?? "127.0.0.1")).toLowerCase();
    const key = `${side}|${bindKey}|${row.listenPort}`;
    if (seen.has(key)) return null;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/**
 * True when this row's listen end is confined to loopback: an omitted
 * `bindHost` (which renders as loopback) or a named loopback address
 * (`127.0.0.0/8`, `::1`, `localhost`). Exported for the plane's wide-bind
 * gate: anything answering false requires the connecting machine's
 * `sshWideForwards` setting. A hostname that merely HAPPENS to resolve to
 * loopback ("mybox.internal") is not loopback here - the test is the name
 * the user wrote, because that name is what the rendered config carries and
 * what DNS can later point elsewhere.
 */
export function isLoopbackForwardBind(row: SshForwardWire): boolean {
  if (row.bindHost === null) return true;
  const host = row.bindHost.toLowerCase();
  // The grammar admits IPv6 only bracketed (HOST_RE), so `[::1]` is the
  // spelling a row can actually carry.
  if (host === "localhost" || host === "[::1]") return true;
  // IPv4 127.0.0.0/8: dotted-quad with each octet 0-255 (the grammar's host
  // shape admits other spellings, and a 127.999.999.999 is not a bindable
  // address - classifying it "wide" fails closed, which is the safe side).
  const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
  return new RegExp(`^127(\\.${OCTET}){3}$`).test(host);
}

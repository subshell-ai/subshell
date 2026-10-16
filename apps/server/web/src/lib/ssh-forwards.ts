import { SSH_MAX_FORWARD_ROWS } from "@internal/subshell-protocol";
import type { SshForwardRow } from "@/lib/ssh";

/**
 * Port-forward rows as the FORM holds them: every value a string, because a
 * half-typed port is normal keystrokes and NaN is not. The pure checks here
 * mirror the server's refusals (kind rules, port bounds, host hygiene,
 * duplicate binds) so a person sees the problem beside the field instead of
 * after pressing Start; the protocol grammar on the server stays the
 * authority, and nothing here needs to be a perfect copy of it.
 */
export type SshForwardDraftRow = {
  kind: "local" | "remote" | "dynamic";
  listenPort: string;
  bindHost: string;
  targetHost: string;
  targetPort: string;
};

export const EMPTY_SSH_FORWARD_ROW: SshForwardDraftRow = {
  kind: "local",
  listenPort: "",
  bindHost: "",
  targetHost: "",
  targetPort: "",
};

/** True when a row holds nothing but its default kind: an empty row is not a forward. */
export function sshForwardRowEmpty(row: SshForwardDraftRow): boolean {
  return (
    row.listenPort.trim() === "" &&
    row.bindHost.trim() === "" &&
    row.targetHost.trim() === "" &&
    row.targetPort.trim() === ""
  );
}

const PORT_RE = /^\d{1,5}$/;

function isPortText(value: string): boolean {
  if (!PORT_RE.test(value.trim())) return false;
  const n = Number(value.trim());
  return n >= 1 && n <= 65535;
}

/** The host hygiene the wire grammar also refuses: no option-like start, no whitespace or control characters, bounded length. */
function isHostText(value: string): boolean {
  const host = value.trim();
  return host.length > 0 && host.length <= 253 && !host.startsWith("-") && !/[\s\p{Cc}]/u.test(host);
}

/** A row problem and its tone: `gap` means "nothing typed yet" (gold), else the typed value is wrong (red). */
export type SshForwardRowProblem = { text: string; gap: boolean };

/**
 * The first problem with one row, in the voice of the field it belongs to,
 * with the gold/red split the form substrate uses (ruling 2026-09-30): an
 * empty required field is a requirement not yet filled, a typed value that
 * fails the same rule is a hard error.
 */
export function sshForwardRowProblem(row: SshForwardDraftRow): SshForwardRowProblem | null {
  if (!isPortText(row.listenPort))
    return { text: "Enter a listen port from 1 to 65535.", gap: row.listenPort.trim() === "" };
  if (row.bindHost.trim() !== "" && !isHostText(row.bindHost))
    return {
      text: "Enter the bind host as a plain name or address, or leave it blank for loopback.",
      gap: false,
    };
  if (row.kind !== "dynamic") {
    if (!isHostText(row.targetHost))
      return { text: "Enter the host to reach through the connection.", gap: row.targetHost.trim() === "" };
    if (!isPortText(row.targetPort))
      return { text: "Enter a target port from 1 to 65535.", gap: row.targetPort.trim() === "" };
  }
  return null;
}

/** The first problem with one row, as plain text (the gating voice; the component reads {@link sshForwardRowProblem} for the tone). */
export function sshForwardRowProblems(row: SshForwardDraftRow): string | null {
  return sshForwardRowProblem(row)?.text ?? null;
}

/**
 * The protocol's duplicate key for one row: per SIDE (a local/dynamic row
 * binds the connecting machine, a remote row the destination, so one port on
 * each side is two listeners), with the canonical bind (a blank on a local or
 * dynamic row renders as `127.0.0.1`, so it IS that explicit bind twice; a
 * remote blank rides the destination's policy spelling) and the port as a
 * number, so "05432" beside "5432" is one listener. Meaningful only on a row
 * that passes {@link sshForwardRowProblems}.
 */
function forwardListenKey(row: SshForwardDraftRow): string {
  const side = row.kind === "remote" ? "D" : "B";
  const bind = row.bindHost.trim() === "" && row.kind !== "remote" ? "127.0.0.1" : row.bindHost.trim();
  return `${side}|${bind.toLowerCase()}|${String(Number(row.listenPort.trim()))}`;
}

/**
 * True when a candidate row would bind a port a listed forward already binds.
 * The editor's Add button checks this so the list can never hold a pair the
 * server would refuse at launch, and a fresh forward cannot quietly overwrite
 * a listed one.
 */
export function sshForwardRowConflict(row: SshForwardDraftRow, rows: readonly SshForwardDraftRow[]): boolean {
  if (rows.length === 0) return false;
  const key = forwardListenKey(row);
  return rows.some((existing) => forwardListenKey(existing) === key);
}

/**
 * The whole-list answer: per-row problems first, then the LIST rules
 * (duplicate binds, the cap). Returns null when the list is ready to launch;
 * empty rows do not count against anything.
 */
export function sshForwardListProblems(rows: readonly SshForwardDraftRow[]): string | null {
  const filled = rows.filter((row) => !sshForwardRowEmpty(row));
  if (filled.length === 0) return null;
  if (filled.length > SSH_MAX_FORWARD_ROWS)
    return `A connection carries at most ${String(SSH_MAX_FORWARD_ROWS)} port forwards.`;
  for (const row of filled) {
    const problem = sshForwardRowProblems(row);
    if (problem) return problem;
  }
  const listens = new Set<string>();
  for (const row of filled) {
    const key = forwardListenKey(row);
    if (listens.has(key))
      return "Two forwards can't bind the same port on the same machine. Remove one or change a port.";
    listens.add(key);
  }
  return null;
}

/** The list as the wire wants it (empty rows dropped, numbers parsed, blanks null). Call only when {@link sshForwardListProblems} says the list is ready. */
export function sshForwardRowsToWire(rows: readonly SshForwardDraftRow[]): SshForwardRow[] {
  return rows
    .filter((row) => !sshForwardRowEmpty(row))
    .map((row) => ({
      kind: row.kind,
      listenPort: Number(row.listenPort.trim()),
      bindHost: row.bindHost.trim() === "" ? null : row.bindHost.trim(),
      targetHost: row.kind === "dynamic" || row.targetHost.trim() === "" ? null : row.targetHost.trim(),
      targetPort: row.kind === "dynamic" || row.targetPort.trim() === "" ? null : Number(row.targetPort.trim()),
    }));
}

/**
 * The example each kind uses for a still-empty slot. It is the single source
 * of truth for BOTH the field placeholders and the route diagram, so a
 * half-typed row never shows one example in its input and a different one in
 * its diagram. `dynamic` has no target, so its host/port are empty.
 */
export const FORWARD_EXAMPLE: Record<SshForwardDraftRow["kind"], { listen: string; host: string; port: string }> = {
  local: { listen: "5432", host: "db.internal", port: "5432" },
  remote: { listen: "9090", host: "app.local", port: "3000" },
  // No target fields are rendered for a SOCKS forward and its diagram names
  // no target, so the host and port here are deliberately empty: nothing may
  // start treating them as a real example.
  dynamic: { listen: "1080", host: "", port: "" },
};

/**
 * The one-line route diagram for THIS row: the ports and host the person
 * actually typed, with {@link FORWARD_EXAMPLE} standing in for a still-empty
 * slot. A diagram of generic numbers stops helping the moment real ones are
 * filled in; this one tracks the form as it is typed.
 */
export function sshForwardRowDiagram(row: SshForwardDraftRow): string {
  const example = FORWARD_EXAMPLE[row.kind];
  const listen = row.listenPort.trim() === "" ? example.listen : row.listenPort.trim();
  if (row.kind === "dynamic") {
    return `SOCKS client → ${listen} on the connecting machine → destination → any host it asks for`;
  }
  const host = row.targetHost.trim() === "" ? example.host : row.targetHost.trim();
  const targetPort = row.targetPort.trim() === "" ? example.port : row.targetPort.trim();
  return row.kind === "local"
    ? `program → ${listen} on the connecting machine → destination → ${host}:${targetPort}`
    : `program on the destination → ${listen} there → connecting machine → ${host}:${targetPort}`;
}

/**
 * The Listen half of a row in words: a named bind spelled as `bind:port`, a
 * blank on a local or dynamic row is ssh's own loopback, and a blank on a
 * remote row rides the destination's policy. Inputs are the trimmed strings
 * the form holds, or wire values stringified by {@link sshForwardWireLine}.
 */
export function sshForwardListenText(kind: SshForwardDraftRow["kind"], listenPort: string, bindHost: string): string {
  if (bindHost !== "") return `${bindHost}:${listenPort}`;
  return kind === "remote" ? `${listenPort} (by policy)` : `loopback:${listenPort}`;
}

/** The Target half; a SOCKS forward has no fixed target to name. */
export function sshForwardTargetText(kind: SshForwardDraftRow["kind"], targetHost: string, targetPort: string): string {
  return kind === "dynamic" ? "any host the tool picks" : `${targetHost}:${targetPort}`;
}

/**
 * One stored (wire) row as the pane header lists it: `Local · loopback:5432 →
 * db.internal:5432`. The same spellings the editor's table uses, so a person
 * who declared a row recognizes it in the header.
 */
export function sshForwardWireLine(row: SshForwardRow): string {
  const kind = row.kind === "local" ? "Local" : row.kind === "remote" ? "Remote" : "Dynamic";
  const listen = sshForwardListenText(row.kind, String(row.listenPort), row.bindHost ?? "");
  const target = sshForwardTargetText(
    row.kind,
    row.targetHost ?? "",
    row.targetPort === null ? "" : String(row.targetPort),
  );
  return `${kind} · ${listen} ${"→"} ${target}`;
}

/** A stored preset's rows back into form spelling. */
export function sshForwardRowsFromWire(rows: readonly SshForwardRow[] | undefined): SshForwardDraftRow[] {
  return (rows ?? []).map((row) => ({
    kind: row.kind,
    listenPort: String(row.listenPort),
    bindHost: row.bindHost ?? "",
    targetHost: row.targetHost ?? "",
    targetPort: row.targetPort === null ? "" : String(row.targetPort),
  }));
}

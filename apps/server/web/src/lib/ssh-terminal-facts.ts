import type { SshActorSide } from "./ssh";

/**
 * What this TAB knows about the managed SSH terminals it opened.
 *
 * The frozen REST surface answers an SSH pane's facts ONCE, on the
 * `POST /api/ssh/terminals` create (`SshTerminalView`); no read re-answers
 * them (there is no per-pane SSH GET - the gap is recorded in the task-F
 * report). A terminal opened from this SPA is therefore rendered with its
 * trusted destination label, its input-control state, and its uploads
 * disabled only as long as the create response is remembered. This store is
 * that memory: sessionStorage (per-tab working state - the create happened
 * HERE, and sharing the answer across tabs would make another tab claim a
 * control state it never fetched), keyed by pane id.
 *
 * The display material (name, destination, node label) is COPIED in at open
 * time on purpose: the connection can be renamed or deleted afterwards, and
 * the pane's label is the destination the human approved at open, not a
 * later edit's echo. Unknown id = ordinary pane: the terminal renders its
 * normal chrome, because "not managed by the SSH policy as far as this tab
 * can tell" is the honest read, and the BACKEND still gates every generic
 * call against the SSH policy regardless of what the client believes.
 */

/** One managed SSH terminal as this tab remembers it (frozen at open, patched on control acts). */
export interface SshTerminalFacts {
  /** The pane (subshell) id the create returned */
  subshellId: string;
  /** Connection the terminal connects */
  connectionId: string;
  /** Connection display label AT OPEN TIME (a later rename does not rewrite it) */
  displayName: string;
  /** Approved destination, rendered at open time: "deploy@app-02.example.net:22" */
  destination: string;
  /** Connecting node id + label AT OPEN TIME (the route line's "via <node>") */
  nodeId: string;
  nodeLabel: string;
  /** Current input control, patched from every `ssh-control` answer */
  controlOwner: SshActorSide;
  /** Input generation after the last observed transition */
  controlGeneration: number;
}

const STORAGE_KEY = "subshell.sshTerminalFacts";

/** The storage shape: pane id to its facts. */
type FactsMap = Record<string, SshTerminalFacts>;

/** The session store, or null when storage is blocked (private mode, disabled). */
function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readAll(): FactsMap {
  const raw = store()?.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as FactsMap) : {};
  } catch {
    // Corrupt JSON reads empty, never throws: the pane chrome degrades to
    // ordinary, it does not crash on a half-written storage row.
    return {};
  }
}

function writeAll(map: FactsMap): void {
  try {
    store()?.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A blocked or full store costs only this tab's memory; the server-side
    // policy is unchanged either way.
  }
}

/** The remembered facts for one pane, or null when this tab never opened it as SSH. */
export function getSshTerminalFacts(subshellId: string): SshTerminalFacts | null {
  return readAll()[subshellId] ?? null;
}

/** Remember a freshly opened managed terminal (the create response + display material). */
export function putSshTerminalFacts(facts: SshTerminalFacts): void {
  const map = readAll();
  map[facts.subshellId] = facts;
  writeAll(map);
}

/**
 * Patch one pane's facts after a control transition. Absent facts are NOT
 * created: a patch for a pane this tab does not remember means the facts
 * came from somewhere the store never saw, and inventing a row would dress
 * a guess up as the open-time answer.
 */
export function patchSshTerminalFacts(subshellId: string, patch: Partial<Omit<SshTerminalFacts, "subshellId">>): void {
  const existing = readAll()[subshellId];
  if (!existing) return;
  const map = readAll();
  map[subshellId] = { ...existing, ...patch };
  writeAll(map);
}

/** Forget a pane (its delete leaves the facts orphaned; the caller decides). */
export function dropSshTerminalFacts(subshellId: string): void {
  const map = readAll();
  if (!(subshellId in map)) return;
  delete map[subshellId];
  writeAll(map);
}

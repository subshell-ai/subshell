import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NodePreviewEnabledWire, parseNodePreviewEnabled } from "@internal/subshell-protocol";
import { logger } from "../log.js";

/**
 * This node's MIRROR of the preview switch (pane-preview spec Task 3): one
 * transport allowance plus independent app/browser and virtual-display grants.
 * Legacy mirrors without feature fields retain their combined-switch meaning.
 *
 * It is the SSH capability mirror's twin in mechanics and in default. Same
 * file-permission doctrine (0600, temp+rename, its own file beside
 * `ssh-enabled.json` and for the same two reasons: `config.json` is
 * snapshotted at boot and it is the node key's only home). Same fail-CLOSED
 * read: what ENABLING lets Subshell do is stream pane content to anyone the
 * plane's sharing admits, so a setting this process cannot read is not a
 * permission. Absent refuses too: watching panes has no "before" to keep
 * behaving like.
 *
 * **The plane is the sole writer.** There is no `subshell preview-enabled`
 * verb, because turning a machine's pane-watching on from a keyboard at that
 * machine is exactly the decision this gate exists to make someone make in a
 * browser, as the owner, with an audit row. The mirror therefore has exactly
 * one author, a `set_preview_enabled` push. Its readers are the preview gates
 * (this process, fail-closed) and the `ready` report plus heartbeat belt that
 * let the plane notice when the two copies disagree.
 *
 * Because no one stamps this file locally, nothing compares stamps across the
 * two ends: reconciliation never runs newer-wins here, the plane pushes its
 * row, and the node's copy converges by obeying rather than by bargaining.
 */

/** File name inside the agent data dir. */
const FILE = "preview-enabled.json";

/** Absolute path of the preview-switch mirror for a data dir. */
export function previewEnabledPath(dataDir: string): string {
  return join(dataDir, FILE);
}

/**
 * What the mirror says, as the three answers a caller must tell apart: the
 * gate's answers, not the file's biography. Same shape as the SSH mirror's
 * `SshEnabledRead`, cloned for the same reasons.
 *
 * `on` is the only kind that permits, and it carries the stamp because
 * `ready.previewEnabled` must be buildable from what was written. A file that
 * parses to `{ on: false, changedAt }` and a file that does not exist give the
 * SAME answer to every reader (refuse; and the plane's row already says off,
 * so there is nothing to report), and no node-side writer exists whose stamp
 * anyone would later reconcile, so the off file reads as `absent` while its
 * bytes stay on disk. `unreadable` refuses too, but unlike the other two it
 * says so: the answer it produces may match a quiet row, and when the row says
 * on it is a disagreement the plane can only repair if it hears about it.
 */
export type PreviewEnabledRead =
  /** Nothing permits here: no file, or a file that says off. */
  | { kind: "absent" }
  /** Parsed settings, including the selected provider while both features are off. */
  | {
      kind: "on" | "off";
      webPreviewsOn?: boolean;
      displayOn?: boolean;
      displayProvider?: string;
      /** The stored stamp, verbatim: `ready.previewEnabled` is built from it. */
      changedAt: string;
    }
  /** The file exists but is not a state: REFUSED (fail-closed), reported under the file's mtime. */
  | {
      kind: "unreadable";
      /** The file's mtime, ISO. Absent only when the stat failed too, leaving nothing truthful to send. */
      changedAt?: string;
    };

/**
 * Reads the mirror.
 *
 * Total: every failure answers `unreadable` (one warn line) rather than
 * throwing, because every caller is on a path where a throw would cost more
 * than the wrong answer: the preview gates, a heartbeat tick, and the `ready`
 * builder.
 *
 * The parse is the WIRE parser, not a private one: the file holds exactly what
 * travels, and a second validator here would be a second opinion about what
 * `{ on, changedAt }` means.
 */
export function readPreviewEnabled(dataDir: string): PreviewEnabledRead {
  const file = previewEnabledPath(dataDir);
  if (!existsSync(file)) return { kind: "absent" };
  try {
    const state = parseNodePreviewEnabled(JSON.parse(readFileSync(file, "utf8")));
    if (!state) throw new SyntaxError("not a preview-enabled state");
    return state.on || state.displayProvider !== undefined
      ? {
          kind: state.on ? "on" : "off",
          changedAt: state.changedAt,
          ...(state.webPreviewsOn === undefined ? {} : { webPreviewsOn: state.webPreviewsOn }),
          ...(state.displayOn === undefined ? {} : { displayOn: state.displayOn }),
          ...(state.displayProvider === undefined ? {} : { displayProvider: state.displayProvider }),
        }
      : { kind: "absent" };
  } catch (err) {
    logger.withError(err).warn(`preview-enabled: ${file} unreadable; treating this node as PREVIEW-DISABLED`);
    // The mtime, never `now`: this answer refuses, so the plane has to hear
    // about it (a row that says on would push the clean file that repairs it),
    // and the one timestamp available that nobody invented is when the file
    // last changed. A fresh `now` per read would defeat the report memo and
    // put one frame on the wire per heartbeat, forever. A stat that fails in
    // turn leaves the stamp off: the refusal stands, and there is nothing to
    // send.
    const changedAt = mtimeOf(file);
    return changedAt ? { kind: "unreadable", changedAt } : { kind: "unreadable" };
  }
}

/**
 * A file's mtime as an ISO stamp. TOTAL: every caller is on a path where the
 * answer is optional and a throw would cost the whole read.
 */
function mtimeOf(file: string): string | undefined {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * The wire value a read is worth announcing, or `undefined` when there is
 * nothing truthful to say.
 *
 * Every reporting path goes through this so the answers cannot be classified
 * differently in three places: `ready`, the heartbeat memo check and the
 * preview gates all owe the plane the same value for the same file. An
 * unreadable mirror announces the REFUSAL it actually produces, the SSH
 * twin's rule, held for the same reason.
 *
 * @param read - what {@link readPreviewEnabled} answered
 * @returns the `{ on, changedAt }` to send, or `undefined` for absent (the
 * plane's row needs no echo from a node agreeing off) and for an unstamped
 * unreadable
 */
export function reportablePreviewEnabled(read: PreviewEnabledRead): NodePreviewEnabledWire | undefined {
  if (read.kind === "on" || read.kind === "off")
    return {
      on: read.kind === "on",
      changedAt: read.changedAt,
      ...(read.webPreviewsOn === undefined ? {} : { webPreviewsOn: read.webPreviewsOn }),
      ...(read.displayOn === undefined ? {} : { displayOn: read.displayOn }),
      ...(read.displayProvider === undefined ? {} : { displayProvider: read.displayProvider }),
    };
  if (read.kind === "unreadable" && read.changedAt) return { on: false, changedAt: read.changedAt };
  return undefined;
}

/**
 * The value this machine would hand `ready`, and the shape every preview gate
 * reads: a permit is `?.on === true` and NOTHING else. Absent, unreadable,
 * and a malformed file all answer a refusal (or nothing), never a permit. The
 * fail-closed rule, spelled once at the read.
 */
export function getPreviewEnabled(dataDir: string): NodePreviewEnabledWire | undefined {
  return reportablePreviewEnabled(readPreviewEnabled(dataDir));
}

/**
 * Persists the mirror, 0600, via temp + rename.
 *
 * Atomic for the SSH reason and sharper: a gate may read this at any instant,
 * and a half-written file parses as corrupt, which under the fail-closed rule
 * REFUSES every preview act for as long as the write takes.
 *
 * The `state` is stored VERBATIM. The plane sent it; re-stamping here would
 * make the two copies differ by exactly the link delay, and the next `ready`
 * would report a disagreement this process invented, which the plane would
 * "repair" by pushing the same value again, forever.
 *
 * @returns the state as stored
 */
export function setPreviewEnabled(dataDir: string, state: NodePreviewEnabledWire): NodePreviewEnabledWire {
  const file = previewEnabledPath(dataDir);
  const body: NodePreviewEnabledWire = { ...state };
  // 0700, matching the data dir `identity.ts` creates. mkdir's mode is
  // umask-clamped, so it is a floor; the file's own 0600 below is set at
  // creation and is the one that matters.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return body;
}

/** Separate feature gates, with legacy combined mirrors retaining their meaning. */
export function getWebPreviewsEnabled(dataDir: string): boolean {
  const state = getPreviewEnabled(dataDir);
  return state?.on === true && (state.webPreviewsOn ?? state.on);
}
export function getVirtualDisplayEnabled(dataDir: string): boolean {
  const state = getPreviewEnabled(dataDir);
  return state?.on === true && (state.displayOn ?? state.on);
}

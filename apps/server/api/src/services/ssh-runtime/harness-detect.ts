import { allHarnesses, type HarnessInventoryEntry } from "@internal/pane-runtime";
import { parseNodeDetectResults } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { detectEnvNames, detectSpecs, enabledEnvHarnesses, readAgentInventory } from "@/services/nodes/inventory.js";
import { liveSessionForRuntimeNode } from "./session-registry.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";
import { SshRuntimeRefusal } from "./sessions.service.js";
import { requireOwnedSession } from "./sessions-lifecycle.js";

/**
 * The harness-detect seam for runtime sessions (task 25, journey step 5):
 * "which installed agent harnesses does THIS destination have?" answered by
 * the plane asking, the runtime answering exactly what was asked (the node
 * link's `detect` posture, design 2026-10-05 §2's mirror rule), and the answer
 * merged into the SAME cached inventory the node views read
 * (`nodes.inventory_json` via `applyInventory` on the hidden `runtime`-kind
 * node row - the mirror write is this module's, the runtime row starts with
 * nothing).
 *
 * The two verbs:
 * - {@link detectRuntimeSessionHarnesses}: a round trip (owner-gated; a
 *   runtime that did not advertise `"detect"` refuses 409 with the named
 *   `sshCode` `detect_unsupported`, never a silent empty answer).
 * - {@link sessionHarnesses}: the cached mirror read (works offline: it reads
 *   rows, never a session; `online` says whether the live session behind the
 *   row is answering right now, and `env` rides that live session's last
 *   detect answer - a closed session's env answers retired with it, the same
 *   reading an ordinary node's connection facts give).
 */

/** One cached/just-detected harness row, in the view's stable serialization. */
export interface RuntimeHarnessEntryView {
  /** The harness plugin id (the detect spec's `id`). */
  harnessId: string;
  /** The harness's display name from the plane's own manifest (the id itself when the plugin is unknown to this build - the mirror can outlive a disable). */
  harnessName: string;
  /** The destination's binary answer: found and executable there. */
  installed: boolean;
  /** Resolved binary path when installed (null otherwise or unreadable). */
  binaryPath: string | null;
  /** Best available version text: the plugin-parsed version when a parser ran, the raw probe output otherwise (null when never answered). */
  rawVersion: string | null;
  /** Why the binary was not found ("not-on-path" | "override-invalid" | "no-binary"); null when installed or unknown. */
  reason: string | null;
  /** ISO 8601 stamp of the probe (null when an entry carries none). */
  checkedAt: string | null;
}

/** The harnesses view one verb returns: the mirror, its freshness facts, and the env answers. */
export interface RuntimeSessionHarnessesView {
  /** The session id the view is keyed by. */
  sessionId: string;
  /** The hidden runtime node row the mirror is stored on. */
  runtimeNodeId: string;
  /** Whether a LIVE session backs this view right now. */
  online: boolean;
  /** The cached inventory rows this view reports (the requested set when the detect verb named one). */
  harnesses: RuntimeHarnessEntryView[];
  /** The destination's answers for the plane-named env vars (empty until the first detect; retired with a lost session). */
  env: Record<string, string>;
}

const nodesRepo = new NodesRepository(db);
const sessionsRepo = new SshRuntimeSessionsRepository(db);

/** Display names resolve against the plane's own plugin set; an unknown id renders its id (the mirror can outlive a plugin disable). */
function harnessDisplayName(harnessId: string): string {
  return allHarnesses().find((h) => h.id === harnessId)?.name ?? harnessId;
}

function toEntryView(entry: HarnessInventoryEntry): RuntimeHarnessEntryView {
  return {
    harnessId: entry.harnessId,
    harnessName: harnessDisplayName(entry.harnessId),
    installed: entry.installed,
    binaryPath: entry.binaryPath ?? null,
    rawVersion: entry.version ?? null,
    reason: entry.reason ?? null,
    checkedAt: entry.checkedAt ?? null,
  };
}

/** The cached mirror for one runtime node row + the live session's env answers (when any). */
async function buildView(
  sessionId: string,
  runtimeNodeId: string,
  restrictTo: string[] | undefined,
): Promise<RuntimeSessionHarnessesView> {
  const node = await nodesRepo.findById(runtimeNodeId);
  const live = liveSessionForRuntimeNode(runtimeNodeId);
  const entries = node === undefined ? new Map<string, HarnessInventoryEntry>() : readAgentInventory(node).entries;
  const harnesses = [...entries.values()]
    .filter((e) => restrictTo === undefined || restrictTo.includes(e.harnessId))
    .map(toEntryView);
  return {
    sessionId,
    runtimeNodeId,
    online: live !== undefined,
    harnesses,
    env: live?.harnessEnv ?? {},
  };
}

/**
 * The cached mirror read: the hidden runtime node row's `inventory_json`
 * rendered as the view, no round trip. Owner-gated through the session row
 * (a foreign id and a gone id answer the same 404, the invisible-resource
 * convention every by-id verb on this surface obeys). Works for closed
 * sessions - the cache outlives the channel by design (spec §6.2's role for
 * the inventory snapshot).
 */
export async function sessionHarnesses(sessionId: string, userId: string): Promise<RuntimeSessionHarnessesView> {
  const row = await sessionsRepo.findById(sessionId);
  if (row === undefined || row.ownerUserId !== userId) throw new SshRuntimeRefusal(404, "session not found");
  return await buildView(sessionId, row.runtimeNodeId, undefined);
}

/**
 * Ask the destination NOW (task 25's detect round trip), merge, cache, return.
 *
 * The composition mirrors `inventory.ts`'s `detectOnNode` exactly - plane
 * ships the rules (`detectSpecs`) and the env NAMES
 * (`detectEnvNames(enabledEnvHarnesses())`), the runtime probes and answers
 * RAW, the plugin's `parseVersion` runs HERE, the merged rows ride
 * `applyInventory` (the column's only writer of real rows), the env answers
 * land on the live session (an ordinary node stashes them on its connection
 * facts; a runtime's connection IS the session). The ONLY difference is the
 * capability gate: a runtime predating `"detect"` refuses 409 with the named
 * `sshCode` `detect_unsupported` rather than closing its session on an
 * unknown frame - the frame would fail its own grammar there, and the
 * honest plane-side reading of "the other end cannot answer this" is a named
 * refusal.
 *
 * `harnessIds` (optional) narrows the SPECS asked (and the view returned);
 * the env names are always the full enabled union - they are a property of
 * the instance's manifests, not of the subset probed.
 * @throws SshRuntimeRefusal 404 (foreign/absent session), 409
 *         `detect_unsupported` (capability refused or answered unsupported),
 *         502 (malformed runtime answer)
 */
export async function detectRuntimeSessionHarnesses(
  sessionId: string,
  userId: string,
  harnessIds?: string[],
): Promise<RuntimeSessionHarnessesView> {
  const session = requireOwnedSession(sessionId, userId);
  if (!session.hello.capabilities.includes("detect")) {
    throw new SshRuntimeRefusal(
      409,
      "this destination's runtime does not support harness detection; update the runtime binary there",
      "detect_unsupported",
    );
  }
  const all = detectSpecs();
  const specs = harnessIds === undefined ? all : all.filter((s) => harnessIds.includes(s.id));
  const envHarnesses = await enabledEnvHarnesses();
  let data: unknown;
  try {
    data = await session.command(
      { type: "detect", ref: crypto.randomUUID(), specs, envNames: detectEnvNames(envHarnesses) },
      20_000,
    );
  } catch (err) {
    // `unsupported` from the runtime itself (advertised capability, build
    // that answers otherwise anyway) reads as the same named refusal.
    if (err instanceof Error && "detail" in err && (err as { detail?: string }).detail === "unsupported") {
      throw new SshRuntimeRefusal(
        409,
        "the destination runtime refused the detect command as unsupported",
        "detect_unsupported",
      );
    }
    throw err;
  }
  const answer = parseNodeDetectResults(data);
  if (answer === null)
    throw new SshRuntimeRefusal(502, "the runtime answered the detect command with a malformed payload");
  const node = await nodesRepo.findById(session.runtimeNodeId);
  if (node === undefined) throw new SshRuntimeRefusal(404, "session not found");
  const stamp = new Date().toISOString();
  const merged = readAgentInventory(node).entries;
  for (const row of answer.rows) {
    const entry: HarnessInventoryEntry = {
      harnessId: row.harnessId,
      installed: row.installed,
      checkedAt: row.checkedAt ?? stamp,
    };
    if (row.binaryPath) entry.binaryPath = row.binaryPath;
    if (row.reason) entry.reason = row.reason;
    if (row.rawVersion !== undefined) {
      const harness = allHarnesses().find((h) => h.id === row.harnessId);
      const version = harness?.parseVersion ? harness.parseVersion(row.rawVersion) : row.rawVersion;
      if (version) entry.version = version;
    }
    merged.set(row.harnessId, entry);
  }
  await nodesRepo.applyInventory(session.runtimeNodeId, JSON.stringify([...merged.values()]));
  session.harnessEnv = answer.env;
  return await buildView(sessionId, session.runtimeNodeId, harnessIds);
}

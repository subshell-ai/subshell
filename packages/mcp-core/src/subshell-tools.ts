import { isPresetCrossCommReady, joinPresetPrompt, parsePresetPromptBlocks } from "@internal/subshell-protocol";
import type { ToolDeps } from "./tools.js";

/**
 * The subshell/machine half of the `subshell mcp` tools: launching, reading
 * and steering panes, and the instance facts (nodes, presets, plugins) that
 * tell an agent WHERE a launch will land. The channel half is in
 * `channel-tools.ts`; the shared seam and error guidance live in `tools.ts`.
 */

/** One subshell as the API sends it: the fields the projection reads. The server row carries more (UI fields an agent has no surface for: shares, pushes, backoff, bell); they are dropped, never passed through. */
interface SubshellWireRow {
  id: string;
  name: string;
  harnessId: string;
  nodeId: string;
  nodeOffline: boolean;
  status: string;
  activity: string;
  alive: boolean;
  workingDir: string;
  preview: string[];
  waitingSince: string | null;
  exitCode: number | null;
  access: string;
  lastOutputAt: string | null;
  crossAgent: boolean;
}

/** The honest projection list_subshells and get_subshell answer with (spec 2026-09-25 MCP DX). */
export interface SubshellView {
  id: string;
  name: string;
  harnessId: string;
  /** Machine the pane runs on ("local" = the control-plane host). */
  nodeId: string;
  /** True when that machine has no live connection; the pane may still run there. */
  nodeOffline: boolean;
  status: string;
  activity: string;
  alive: boolean;
  workingDir: string;
  preview: string[];
  waitingSince: string | null;
  exitCode: number | null;
  access: string;
  lastOutputAt: string | null;
  /** True = this pane was opened by an agent over MCP, not a human at the UI. */
  crossAgent: boolean;
}

/** Project one wire row to the agent-facing view (req 7: BOTH reads use it). */
function toSubshellView(row: SubshellWireRow): SubshellView {
  return {
    id: row.id,
    name: row.name,
    harnessId: row.harnessId,
    nodeId: row.nodeId,
    nodeOffline: row.nodeOffline,
    status: row.status,
    activity: row.activity,
    alive: row.alive,
    workingDir: row.workingDir,
    preview: row.preview,
    waitingSince: row.waitingSince,
    exitCode: row.exitCode,
    access: row.access,
    lastOutputAt: row.lastOutputAt,
    crossAgent: row.crossAgent === true,
  };
}

/** One node's harness entry as GET /api/nodes sends it (identity + the refusal reason). */
interface NodeHarnessWireRow {
  harnessId: string;
  name: string;
  installed: boolean;
  reason?: string;
}

/** One node as GET /api/nodes answers it, bearer edition: only the fields the projection reads. */
interface NodeWireRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  access: string;
  canLaunch: boolean;
  /** Present on NodeViewSchema (checked there), so required here too. */
  maintenance: boolean;
  inventoryStale: boolean;
  harnesses: NodeHarnessWireRow[];
}

/** One harness row as list_nodes answers it. */
export interface NodeHarnessView {
  harnessId: string;
  name: string;
  /** False until a node's first detection lands, or when the binary is missing. */
  installed: boolean;
  /** Why there is no binary, when the server gave one. */
  reason?: string;
}

/** One machine, projected to what an agent launches with. */
export interface NodeView {
  id: string;
  name: string;
  /** "local" (control-plane host) or "agent". */
  kind: string;
  /** "online" | "offline". */
  status: string;
  access: string;
  canLaunch: boolean;
  /** True when the machine is out of service (accepts no new subshells). */
  maintenance: boolean;
  harnesses: NodeHarnessView[];
  /** True when the harness rows are the cached last-known detect, not a live answer. */
  inventoryStale: boolean;
}

/** A preset row, or a harness-catalog entry (see `listPresets`). */
export interface PresetRow {
  id: string;
  name: string;
  harnessId: string;
  /**
   * True on a real preset whose node, directory, and prompt are ALL set: this
   * one launches from its name alone (spec 2026-09-29 preset-launch-fields -
   * the readiness is derived from the row, never stored). Absent on catalog
   * entries, which are not presets.
   */
  crossCommReady?: boolean;
  /**
   * Present only on catalog entries: this row names a harness the instance
   * could launch (id == harnessId), not saved settings an addressable preset
   * stands behind. Absent on real presets, so existing consumers never see a
   * new field value on the rows they already handle.
   */
  catalogOnly?: true;
}

/** One preset row as GET /api/presets sends it (the launch trio rides every bearer row; envJson is redacted server-side). */
interface PresetsWireRow {
  id: string;
  name: string;
  harnessId: string;
  /** 1 = the operator switched on cross-subshell comms (migration 0043). */
  crossCommEnabled: number;
  nodeId: string | null;
  workingDir: string | null;
  promptBlocks: string | null;
}

/** One plugin row as GET /api/plugins sends it (only the fields the catalog filter reads). */
interface PluginWireRow {
  id: string;
  name: string;
  type: string;
  installed: boolean;
  enabled: boolean;
}

/** The create/restart wire response; `tmuxSocket` is deliberately never forwarded to the agent. */
interface LaunchWireResponse {
  id: string;
  tmuxSocket: string;
  promptDelivered: boolean;
}

/**
 * The tools' shared human-name grammar: EXACT spelling wins outright, else
 * the case-insensitive set stands. Returns the surviving rows (possibly zero,
 * possibly a tie); each caller phrases its own refusal, because each surface
 * names its own remedy. A tie is never silently won by whichever row sorts
 * first: the name is the agent's addressing key.
 */
function nameMatches<T>(rows: T[], want: string, nameOf: (row: T) => string): T[] {
  const insensitive = rows.filter((r) => nameOf(r).toLowerCase() === want.toLowerCase());
  const exact = insensitive.filter((r) => nameOf(r) === want);
  return exact.length > 0 ? exact : insensitive;
}

/**
 * The parenthetical of a tie refusal: the competing SPELLINGS when they
 * differ (with a case-only collision they are the whole actionable content of
 * "ask for an exact spelling"), else the ids: identical spellings rendered
 * twice say nothing, and only the id tells such rows apart.
 */
function spellingsOrIds<T>(matches: T[], nameOf: (row: T) => string, idOf: (row: T) => string): string {
  const distinct = new Set(matches.map(nameOf));
  return distinct.size > 1 ? matches.map((r) => `'${nameOf(r)}'`).join(", ") : matches.map((r) => idOf(r)).join(", ");
}

/** `list_subshells` */
export async function listSubshells(deps: ToolDeps): Promise<SubshellView[]> {
  const rows = await deps.api.req<SubshellWireRow[]>("/api/subshells");
  return rows.map(toSubshellView);
}

/**
 * `get_subshell`: by id, or by NAME resolved through the list rows with the
 * shared grammar (exact spelling, then case-insensitive; a tie is refused).
 * Exactly one of the two must be given (the schema refines it; this guard is
 * the honest function-level answer for direct callers).
 */
export async function getSubshell(deps: ToolDeps, args: { id?: string; name?: string }): Promise<SubshellView> {
  if (args.id !== undefined) {
    return toSubshellView(await deps.api.req<SubshellWireRow>(`/api/subshells/${encodeURIComponent(args.id)}`));
  }
  if (args.name === undefined) throw new Error("subshell: get_subshell needs an id or a name");
  const rows = await deps.api.req<SubshellWireRow[]>("/api/subshells");
  const matches = nameMatches(rows, args.name, (r) => r.name);
  if (matches.length === 0) {
    throw new Error(`subshell: no subshell named '${args.name}'; find ids with list_subshells`);
  }
  if (matches.length > 1) {
    throw new Error(
      `subshell: more than one subshell named '${args.name}' (${spellingsOrIds(
        matches,
        (r) => r.name,
        (r) => r.id,
      )}); ask for an exact spelling, or address the id from list_subshells`,
    );
  }
  return toSubshellView(matches[0]);
}

/**
 * `list_presets`: the owner's presets across every agent the INSTANCE offers
 * (the server's list is store-scoped since the 2026-09-13 follow-up: a
 * harness installed and enabled on the instance lists its presets regardless
 * of which node's PATH holds the binary; per-node fit is decided at launch),
 * plus the harness CATALOG (spec 2026-09-25): a fresh instance has zero
 * presets, exactly when an agent most needs the harness ids, so every plugin
 * the instance could launch right now (a harness type, held in the store,
 * enabled) earns an additive `catalogOnly: true` row. `network` plugins drive
 * no pane and never earn one.
 */
export async function listPresets(deps: ToolDeps): Promise<PresetRow[]> {
  const [rows, { plugins }] = await Promise.all([
    deps.api.req<PresetsWireRow[]>("/api/presets"),
    deps.api.req<{ plugins: PluginWireRow[] }>("/api/plugins"),
  ]);
  const presets = rows.map(({ id, name, harnessId, crossCommEnabled, nodeId, workingDir, promptBlocks }) => ({
    id,
    name,
    harnessId,
    crossCommReady: isPresetCrossCommReady({ crossCommEnabled, nodeId, workingDir, promptBlocks }),
  }));
  const catalog = plugins
    .filter((p) => (p.type === "agent-harness" || p.type === "terminal") && p.installed && p.enabled)
    .map((p) => ({ id: p.id, name: p.name, harnessId: p.id, catalogOnly: true as const }));
  return [...presets, ...catalog];
}

/** `list_nodes`: the machines this pane's owner can see, projected for launching. */
export async function listNodes(deps: ToolDeps): Promise<NodeView[]> {
  // The route answers `{ nodes: [...] }` (its 200 schema declares the wrapper;
  // list-nodes.route.ts in apps/server/api/src/api/nodes is the shape authority).
  const nodes = (await deps.api.req<{ nodes: NodeWireRow[] }>("/api/nodes")).nodes;
  return nodes.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    access: r.access,
    canLaunch: r.canLaunch,
    maintenance: r.maintenance,
    harnesses: r.harnesses.map((h) => ({
      harnessId: h.harnessId,
      name: h.name,
      installed: h.installed,
      ...(h.reason !== undefined ? { reason: h.reason } : {}),
    })),
    inventoryStale: r.inventoryStale,
  }));
}

/** The create route's `prompt` body cap (`create-subshell.route.ts`); the
 *  tool checks the COMPOSED text against it because append happens client-side.
 *  TODO: the same 20 000 sits in the route schema and in presets.route's
 *  `MAX_PRESET_PROMPT_CHARS`; if the cap ever moves, move it to
 *  `@internal/subshell-protocol` first and import it at all three sites. */
const MAX_CREATE_PROMPT_CHARS = 20_000;

/**
 * `create_subshell`: an agent launches FROM a preset (required since spec
 * 2026-09-29 preset-launch-fields): the preset's NAME is addressed (ids are
 * not shared context), its harness is derived unless the call asserts one, and
 * everything else the call says OVERRIDES what the preset carries - node,
 * directory, and the prompt. A call that names no dir when the preset names
 * none gets the server's 400 naming both spellings. The prompt relationship is
 * the agent's choice (ruling 2026-09-29): no `prompt` uses the preset's,
 * `"append"` (the default) puts the agent's text AFTER it, `"replace"` sends
 * only the agent's. The node, when given, resolves client-side as an id OR
 * display name so the server only ever sees an id.
 */
export async function createSubshell(
  deps: ToolDeps,
  args: {
    name?: string;
    harness?: string;
    preset: string;
    workingDir?: string;
    prompt?: string;
    /** "append" (default) or "replace"; only read when `prompt` is given. */
    promptMode?: "append" | "replace";
    node?: string;
  },
): Promise<{ id: string; promptDelivered: boolean }> {
  // With a harness asserted, the lookup stays scoped to it (names are unique
  // per harness); without one, the WHOLE list is searched and the winning row
  // decides the harness.
  const presets = await deps.api.req<PresetsWireRow[]>(
    "/api/presets",
    args.harness !== undefined ? { query: { harnessId: args.harness } } : {},
  );
  // The name is the agent's addressing key, so a tie is REFUSED, never
  // silently won by whichever row sorts first: launching the wrong preset
  // writes the wrong credential layer. Migration 0028 made the tie
  // unreachable on a current instance (a NOCASE unique index), and this
  // stays anyway: the lookup runs over whatever list the SERVER returned,
  // which may be an older instance, and a client cannot check another
  // machine's constraints. Harness-less ties are named by their HARNESSes:
  // that is the tie's actionable content, and the `harness` param is the fix.
  const matches = nameMatches(presets, args.preset, (p) => p.name);
  if (matches.length === 0) {
    throw new Error(
      `subshell: no preset named '${args.preset}'${
        args.harness !== undefined ? ` for harness '${args.harness}'` : ""
      }; call list_presets for options`,
    );
  }
  if (matches.length > 1) {
    const harnesses = [...new Set(matches.map((p) => p.harnessId))];
    if (args.harness === undefined && harnesses.length > 1) {
      throw new Error(
        `subshell: '${args.preset}' names presets on ${harnesses.map((h) => `'${h}'`).join(" and ")}; pass the harness`,
      );
    }
    throw new Error(
      `subshell: more than one preset named '${args.preset}'${
        args.harness !== undefined ? ` for harness '${args.harness}'` : ""
      } (${spellingsOrIds(
        matches,
        (p) => p.name,
        (p) => p.id,
      )}); rename one, or ask for an exact spelling`,
    );
  }
  const presetRow = matches[0];
  if (args.harness !== undefined && presetRow.harnessId !== args.harness) {
    throw new Error(
      `subshell: preset '${args.preset}' is for harness '${presetRow.harnessId}', not the asserted '${args.harness}'`,
    );
  }
  // The prompt relationship, composed here because the SERVER only ever sees
  // one final string (its rule: body prompt wins, else the preset's blocks).
  let prompt: string | undefined;
  if (args.prompt !== undefined) {
    if (args.promptMode === "replace") {
      prompt = args.prompt;
    } else {
      let presetText: string;
      try {
        presetText = joinPresetPrompt(parsePresetPromptBlocks(presetRow.promptBlocks) ?? []);
      } catch {
        throw new Error(
          `subshell: preset '${args.preset}' has an unreadable prompt stack; fix or clear it in the web preset editor`,
        );
      }
      prompt = presetText.trim() === "" ? args.prompt : `${presetText}\n\n${args.prompt}`;
    }
    // The composed text rides the create body, which caps `prompt` at 20 000
    // chars; refuse HERE with the remedy instead of relaying an opaque
    // schema-validation 400 from the route (spec 2026-09-29 Task 3's cap note).
    if (prompt.length > MAX_CREATE_PROMPT_CHARS) {
      const remedy =
        args.promptMode === "replace"
          ? "Shorten the prompt; the preset's own text is already skipped."
          : `Shorten your prompt, or pass prompt_mode "replace" to skip the preset's text.`;
      throw new Error(
        `subshell: the composed prompt is ${prompt.length} chars; the launch accepts at most ${MAX_CREATE_PROMPT_CHARS}. ${remedy}`,
      );
    }
  }
  let nodeId: string | undefined;
  if (args.node !== undefined) {
    // Same `{ nodes: [...] }` wrapper as listNodes (see the note there).
    const nodes = (await deps.api.req<{ nodes: NodeWireRow[] }>("/api/nodes")).nodes;
    // Exact id wins FIRST: ids survive renames, and a node whose name happens
    // to read like another node's id must never hijack the id-addressed one.
    const byId = nodes.filter((n) => n.id === args.node);
    const matches = byId.length > 0 ? byId : nameMatches(nodes, args.node, (n) => n.name);
    if (matches.length === 0) {
      const available = nodes.map((n) => n.name).join(", ");
      throw new Error(
        `subshell: no node '${args.node}'${available ? `; available: ${available}` : "; no machines are enrolled"}; call list_nodes`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `subshell: more than one node matches '${args.node}' (${spellingsOrIds(
          matches,
          (n) => n.name,
          (n) => n.id,
        )}); pass the node id`,
      );
    }
    nodeId = matches[0].id;
  }
  const res = await deps.api.req<LaunchWireResponse>("/api/subshells", {
    method: "POST",
    body: {
      harnessId: args.harness ?? presetRow.harnessId,
      presetId: presetRow.id,
      // An omitted dir rides the preset's (the server resolves); sending
      // `workingDir: undefined` over JSON would drop it anyway, but staying
      // absent here keeps the wire honest about what the agent actually said.
      ...(args.workingDir !== undefined ? { workingDir: args.workingDir } : {}),
      name: args.name,
      prompt,
      nodeId,
    },
  });
  return { id: res.id, promptDelivered: res.promptDelivered };
}

/**
 * `restart_subshell`: an optional prompt is typed into the revived pane once
 * it settles; `promptDelivered` reports whether. No prompt keeps the
 * body-less POST byte-identical to the plain restart.
 */
export async function restartSubshell(
  deps: ToolDeps,
  args: { id: string; prompt?: string },
): Promise<{ id: string; promptDelivered: boolean }> {
  const res = await deps.api.req<LaunchWireResponse>(`/api/subshells/${encodeURIComponent(args.id)}/restart`, {
    method: "POST",
    ...(args.prompt !== undefined ? { body: { prompt: args.prompt } } : {}),
  });
  return { id: res.id, promptDelivered: res.promptDelivered };
}
/** `terminate_subshell` */
export const terminateSubshell = (deps: ToolDeps, id: string) =>
  deps.api.req(`/api/subshells/${encodeURIComponent(id)}/terminate`, { method: "POST" });
/** `delete_subshell` */
export const deleteSubshell = (deps: ToolDeps, id: string) =>
  deps.api.req(`/api/subshells/${encodeURIComponent(id)}`, { method: "DELETE" });
/** `read_subshell_log`: the tail of the pane's captured output, passed through. */
export const readSubshellLog = (deps: ToolDeps, id: string) =>
  deps.api.req<{ lines: string[]; truncated: boolean }>(`/api/subshells/${encodeURIComponent(id)}/log`);
/**
 * `send_to_subshell`: types `text` into a running pane over REST; `submit`
 * (default true) presses Enter after it. The server's gate decides whose
 * panes this reaches (the owner's, at edit access); a 409 names it not
 * running (never running, or its pane exited and the row is parked: restart
 * revives it) or the node offline.
 */
export const sendToSubshell = (deps: ToolDeps, args: { id: string; text: string; submit?: boolean }) =>
  deps.api.req<{ ok: true }>(`/api/subshells/${encodeURIComponent(args.id)}/input`, {
    method: "POST",
    body: { text: args.text, submit: args.submit ?? true },
  });

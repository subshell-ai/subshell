import {
  type BuildCommandInput,
  type HarnessPluginFactory,
  type HarnessSubagentPane,
  type HarnessSubagentSelectInput,
  type HarnessSubagentSelectResult,
  type HarnessSubagentView,
  MCP_SERVER_NAME,
  type McpLaunchSpec,
  type McpRegistration,
  type McpSetupInfo,
  type PluginCapability,
  type PluginHost,
  type PresetDefinition,
  type PresetValidationResult,
  type SettingsField,
  type SubshellPlugin,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

// Codex filters the MCP child's environment. Forward names only so pane
// credentials are resolved at launch, never written into config or argv.
// SUBSHELL_SERVER_DATA_DIR is the one name no pane bakes; it's here for the
// data-dir fallback mcp-core reads when Codex runs outside Subshell.
const MCP_ENV_VARS = [
  "SUBSHELL_API_KEY",
  "SUBSHELL_BASE_URL",
  "SUBSHELL_ID",
  "SUBSHELL_NAME",
  "SUBSHELL_DATA_DIR",
  "SUBSHELL_SERVER_DATA_DIR",
];

/** Known Codex settings, applied as per-invocation CLI flags. */
const CODEX_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "model",
    label: "Model",
    description: "Model name passed as -m/--model (e.g. 'gpt-5-codex')",
    type: "string",
  },
  {
    key: "sandbox",
    label: "Sandbox",
    description: "What the agent may touch without asking (-s/--sandbox)",
    type: "select",
    choices: ["read-only", "workspace-write", "danger-full-access"],
  },
  {
    key: "askForApproval",
    label: "Ask for approval",
    description: "When codex pauses for a human decision (-a/--ask-for-approval)",
    type: "select",
    choices: ["on-request", "never"],
  },
];

const SUGGESTED_ENV: { key: string; description: string }[] = [
  // CODEX_HOME is deliberately NOT suggested: it locates ~/.codex, which
  // holds the user's auth.json — pointing it elsewhere logs the subshell out
  // of ChatGPT and hides their config.toml. subshell never needs it: its MCP
  // wiring rides per-invocation `-c` overrides (mcpRegistration), so the
  // user's own dir is used as-is.
  { key: "OPENAI_API_KEY", description: "API key for the api-key login mode (else ChatGPT sign-in)" },
];

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "--search", description: "Enable live web search" },
  { flag: "-p work", description: "Apply a profile from ~/.codex/config.toml" },
  {
    flag: '-c mcp_servers.foo.command="/usr/bin/foo"',
    description: "One-off config override (dotted path, value parsed as TOML)",
  },
];

/** A TOML basic string from an ASCII-safe JS string. */
function tomlString(value: string): string {
  // JSON.stringify emits exactly TOML's basic-string syntax for these shapes
  // (same `"` delimiter, same `\"`/`\\`/`\n` escapes) — command paths and argv
  // tokens are filesystem-safe by construction, so the encodings coincide.
  return JSON.stringify(value);
}

/** A TOML inline array of basic strings — same JSON-compatibility argument. */
function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

const OVERLAY_MARKER = "Select an agent to watch.";
const EMPTY_COMPOSER = "Ask Codex to do anything";
/** ESC [ 1 ; 3 D — Codex's Alt+Left, which returns a subagent view to Main. */
const ALT_LEFT = "\u001b[1;3D";
/** The picker's own navigation bytes: Home atoms the scan to the top, PageDown
 * paints the next page, and the arrows move the highlight onto a painted row. */
const PICKER_HOME = "\u001b[H";
const PICKER_PAGE_DOWN = "\u001b[6~";
const PICKER_UP = "\u001b[A";
const PICKER_DOWN = "\u001b[B";
const ESCAPE = "\u001b";

/**
 * The text sitting in Codex's composer, if any. The placeholder is not input;
 * the overlay's numbered lines are not the composer either. Returning a
 * non-empty string means typing `/subagents` would append to a real prompt,
 * so the picker act refuses instead of clobbering it.
 */
function composerText(screen: string): string {
  const line = screen
    .split("\n")
    .reverse()
    .find((row) => /^\s*›\s*/.test(row));
  const text = line?.replace(/^\s*›\s*/, "").trim() ?? "";
  return text === EMPTY_COMPOSER ? "" : text;
}

/** One keystroke batch's settle; Codex can fold an Enter sent in the same burst into the paste. */
const COMMAND_SETTLE_MS = 120;

/** Main's status line, not a transcript mention of it. */
function isMainView(screen: string): boolean {
  const tail = screen
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-4)
    .join(" ")
    .replace(/\s+/g, " ");
  return tail.includes("Main [default]") && !tail.includes("Viewing sub-agent");
}

/**
 * A real picker, not the marker text appearing in transcript history. The
 * footer and a numbered row are what distinguish the overlay. The row number
 * is not anchored to 1: Codex paints only eight rows at a time, so a scrolled
 * page starts at whatever row is at its top and row 1 is off-screen.
 */
function hasPicker(screen: string): boolean {
  // The LAST marker owns a visible overlay; an earlier one is transcript text.
  const overlay = screen.lastIndexOf(OVERLAY_MARKER);
  if (overlay === -1) return false;
  const block = screen.slice(overlay);
  const tail = screen
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-2)
    .join(" ");
  return (
    /enter select\s*·\s*esc back/.test(tail) &&
    block.includes("enter select") &&
    /^\s*(?:›\s*)?\d+\.\s+•\s+/m.test(block)
  );
}

async function typeCommand(pane: HarnessSubagentPane, text: string): Promise<void> {
  await pane.type(text);
  // Codex can fold an Enter sent in the same paste burst into the text. Wait
  // for the composer to show the command before submitting it.
  const rendered = await waitForScreen(pane, (screen) => composerText(screen) === text, 1500)
    .catch(() => undefined)
    .then(async (value) => value ?? (composerText(await pane.read()) === text ? "" : undefined));
  if (rendered === undefined) throw new Error("Codex didn't render the command in its composer.");
  await pane.type("\r");
}

async function waitForScreen(
  pane: HarnessSubagentPane,
  predicate: (screen: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let screen = await pane.read();
  while (!predicate(screen)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex's agent picker.");
    await new Promise((resolve) => setTimeout(resolve, 75));
    screen = await pane.read();
  }
  return screen;
}

/** A closed picker must survive two consecutive reads; a half-painted frame doesn't. */
async function waitForPickerClosed(pane: HarnessSubagentPane, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | undefined;
  while (Date.now() < deadline) {
    const screen = await pane.read();
    if (!hasPicker(screen) && previous !== undefined && !hasPicker(previous)) return screen;
    previous = screen;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Timed out waiting for Codex's agent picker to close.");
}

/**
 * The picker's 1-based row for this id, read from the ids it prints. A narrow
 * pane wraps a long id onto the next line, so each numbered row is assembled
 * from its own lines before the id is matched. Reading the ids matters:
 * completed children stay listed in Codex's picker, so a roster position
 * would pick the wrong row as soon as a child finishes.
 */
const PICKER_ROW = /^\s*(?:›\s*)?(\d+)\.\s+•\s+(.*)$/;
const HIGHLIGHTED_ROW = /^\s*›\s*(\d+)\.\s+•\s+(.*)$/;
const PICKER_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function pickerLines(screen: string): string[] | undefined {
  const overlay = screen.lastIndexOf(OVERLAY_MARKER);
  return overlay === -1 ? undefined : screen.slice(overlay).split("\n");
}

/** A row plus up to three indented id fragments; labels and descriptions don't join. */
function pickerRowText(lines: string[], start: number, match: RegExpMatchArray): string {
  let text = match[2] ?? "";
  for (let j = start + 1; j < Math.min(lines.length, start + 4); j++) {
    const next = lines[j] ?? "";
    if (!/^\s+[0-9a-f-]+\s*$/i.test(next)) break;
    text += next;
  }
  return text;
}

function pickerRowId(text: string): string | undefined {
  // Codex prints the child id in the row's trailing column. A task label that
  // happens to contain a UUID must not win: take the LAST id on the row.
  return text.replace(/\s+/g, "").match(new RegExp(PICKER_ID.source, "ig"))?.at(-1);
}

/**
 * A hidden-id row's label, joined across the popup's wrapped continuation
 * lines. Codex wraps the whole row at the popup width and indents the
 * continuation by the row's prefix; task names are [a-z0-9_] with no spaces,
 * so trimming the indent and concatenating restores the name exactly.
 */
function wrappedPickerRowLabel(lines: string[], start: number, match: RegExpMatchArray): string {
  let label = (match[2] ?? "").trimEnd();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    if (PICKER_ROW.test(line) || /^\s*[↑↓]\s*$/.test(line) || /^\s*enter select/.test(line)) break;
    label += line.trim();
  }
  return label;
}

/** One painted row, with whether it is the one Codex marks as selected. */
interface PaintedPickerRow {
  index: number;
  text: string;
  label: string;
  highlighted: boolean;
}

/**
 * The numbered rows actually painted on the current page, in order. A scrolled
 * page starts at any number; wrapped task names can begin with "2. ", so each
 * row must be the one after the previous to count.
 *
 * Codex paints its id column for every row or hides it for all of them. A
 * narrow pane hides it, and a long name then wraps, so the label is joined
 * back together. With the column painted, the id stays the identity and its
 * own wrapped fragments are joined by {@link pickerRowText}.
 */
function paintedPickerRows(screen: string): PaintedPickerRow[] {
  const lines = pickerLines(screen) ?? [];
  const starts: { index: number; start: number; match: RegExpMatchArray }[] = [];
  let previous: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(PICKER_ROW);
    if (!match) continue;
    const index = Number(match[1]);
    if (previous !== undefined && index !== previous + 1) continue;
    previous = index;
    starts.push({ index, start: i, match });
  }
  // The first painted row tells the layout: the id is one column for the
  // whole popup, and a long id wraps onto continuation lines.
  const first = starts[0];
  const idsVisible = first !== undefined && pickerRowId(pickerRowText(lines, first.start, first.match)) !== undefined;
  return starts.map(({ index, start, match }) => {
    const label = idsVisible ? (match[2] ?? "") : wrappedPickerRowLabel(lines, start, match);
    return {
      index,
      text: idsVisible ? pickerRowText(lines, start, match) : label,
      label,
      highlighted: HIGHLIGHTED_ROW.test(lines[start] ?? ""),
    };
  });
}

/**
 * The child a picker act targets, with the names its row may print. The id
 * column is authoritative when Codex paints it, but a narrow pane hides the
 * description column (the picker needs 24 columns beside the names), so only
 * the row's label identifies the child there. Codex labels a path-backed
 * child by its canonical agent path, while the hooks report the bare task
 * name the parent asked for; both forms are matched.
 */
interface PickerTarget {
  id: string;
  labels: readonly string[];
}

function pickerTarget(agentId: string, agents: readonly HarnessSubagentView[]): PickerTarget {
  const name = agents.find((agent) => agent.id === agentId)?.name.trim() ?? "";
  return {
    id: agentId,
    labels: name === "" ? [] : [name, name.startsWith("/") ? name : `/root/${name}`],
  };
}

/** A row's printed name without the picker's own state suffixes. */
function pickerRowLabel(label: string): string {
  let text = label.trim();
  for (;;) {
    const stripped = text.replace(/\s+\((?:current|needs approval)\)$/, "");
    if (stripped === text) return text;
    text = stripped;
  }
}

/** Whether this row printed the target's id; a painted id is decisive. */
function pickerRowIdMatch(row: { text: string }, target: PickerTarget): boolean {
  return pickerRowId(row.text)?.toLowerCase() === target.id.toLowerCase();
}

/** Whether this row carries the target's name, when no other id is printed. */
function pickerRowLabelMatch(row: { text: string; label: string }, target: PickerTarget): boolean {
  const label = pickerRowLabel(row.label);
  if (!target.labels.includes(label)) return false;
  // A UUID the label itself carries is part of the child's name, because a
  // hidden id column prints no separate token. One the label doesn't carry is
  // the printed id column, and a different id means another thread reused the
  // name, so this row is not the target.
  const printedId = pickerRowId(row.text);
  return printedId === undefined || label.toLowerCase().includes(printedId.toLowerCase());
}

/** Whether a painted row is the target: a printed id wins, its label is the fallback. */
function pickerRowMatches(row: { text: string; label: string }, target: PickerTarget): boolean {
  return pickerRowIdMatch(row, target) || pickerRowLabelMatch(row, target);
}

function pickerIndex(screen: string, target: PickerTarget | null): number | undefined {
  if (!hasPicker(screen)) return undefined;
  const rows = paintedPickerRows(screen);
  if (target === null) return rows.find((row) => /^\s*Main\s*\[default\]/.test(row.label))?.index;
  // A printed id is authoritative. Codex keeps closed children listed and
  // releases their path for reuse, so a same-name row may appear earlier.
  return (
    rows.find((row) => pickerRowIdMatch(row, target))?.index ??
    rows.find((row) => pickerRowLabelMatch(row, target))?.index
  );
}

/** The row Codex marks with `›` after a picker keypress. */
function highlightedPickerRow(screen: string): PaintedPickerRow | undefined {
  return paintedPickerRows(screen).find((row) => row.highlighted);
}

/** What a painted page shows: its ordered row numbers and the highlight. */
function pickerPageSignature(screen: string): string {
  return `${paintedPickerRows(screen)
    .map((row) => row.index)
    .join(",")}|${highlightedPickerRow(screen)?.index ?? ""}`;
}

/** Whether Codex paints its down arrow, i.e. rows exist below the painted page. */
function pickerHasMoreBelow(screen: string): boolean {
  const overlay = screen.lastIndexOf(OVERLAY_MARKER);
  return overlay !== -1 && /^\s*↓\s*$/m.test(screen.slice(overlay));
}

/** Return the picker to row 1, so every scan starts from a known page. */
async function homePicker(pane: HarnessSubagentPane, screen: string, wait: (ms: number) => number): Promise<string> {
  if (paintedPickerRows(screen)[0]?.index === 1) return screen;
  const before = pickerPageSignature(screen);
  await pane.type(PICKER_HOME);
  screen = await waitForScreen(pane, (next) => !hasPicker(next) || pickerPageSignature(next) !== before, wait(1500));
  if (!hasPicker(screen)) throw new Error("Codex closed its agent picker before selecting.");
  if (paintedPickerRows(screen)[0]?.index !== 1) throw new Error("Codex didn't move its picker to the top.");
  return screen;
}

/** Page down once, and prove the popup moved. */
async function pagePickerDown(
  pane: HarnessSubagentPane,
  screen: string,
  wait: (ms: number) => number,
): Promise<string> {
  const before = pickerPageSignature(screen);
  await pane.type(PICKER_PAGE_DOWN);
  const next = await waitForScreen(pane, (s) => !hasPicker(s) || pickerPageSignature(s) !== before, wait(1500));
  if (!hasPicker(next)) throw new Error("Codex closed its agent picker before selecting.");
  if (pickerPageSignature(next) === before) throw new Error("Codex didn't move its picker page.");
  return next;
}

/**
 * Bring the target onto the painted page. Codex's selection view paints at
 * most eight rows over a roster that can hold dozens, so the row a click names
 * is usually off-screen when the picker opens on Main. Home first makes the
 * scan deterministic even when a previous attempt left the picker scrolled;
 * PageDown then walks the list, and row numbers dedupe overlapping pages.
 */
async function revealPickerRow(
  pane: HarnessSubagentPane,
  target: PickerTarget | null,
  screen: string,
  wait: (ms: number) => number,
): Promise<string> {
  screen = await homePicker(pane, screen, wait);
  if (target === null) {
    for (;;) {
      if (pickerIndex(screen, null) !== undefined) return screen;
      // The down arrow is the list's own end-of-page marker: no arrow means the
      // painted page is the last one, so an absent target is absent from the roster.
      if (!pickerHasMoreBelow(screen)) throw new Error("Codex didn't list that subagent in its picker.");
      screen = await pagePickerDown(pane, screen, wait);
    }
  }
  // A printed id settles identity immediately. With the id column hidden,
  // count the distinct rows whose name matches across the whole picker: a
  // closed child keeps its row and Codex releases its path for reuse, so two
  // rows can print the same name. Guessing one would show the wrong child.
  const labelRows = new Set<number>();
  for (;;) {
    const rows = paintedPickerRows(screen);
    if (rows.some((row) => pickerRowIdMatch(row, target))) return screen;
    for (const row of rows) {
      if (pickerRowLabelMatch(row, target)) labelRows.add(row.index);
    }
    if (!pickerHasMoreBelow(screen)) break;
    screen = await pagePickerDown(pane, screen, wait);
  }
  if (labelRows.size === 0) throw new Error("Codex didn't list that subagent in its picker.");
  if (labelRows.size > 1) throw new Error("Codex listed more than one row for that subagent.");
  // The scan ended on the last page; go back to the one row that matched.
  screen = await homePicker(pane, screen, wait);
  for (;;) {
    if (paintedPickerRows(screen).some((row) => pickerRowLabelMatch(row, target))) return screen;
    if (!pickerHasMoreBelow(screen)) throw new Error("Codex didn't list that subagent in its picker.");
    screen = await pagePickerDown(pane, screen, wait);
  }
}

/**
 * Move the highlight onto the target row one painted step at a time. Arrows
 * are used, never the row's digit: the digit shortcut only reaches rows 1-9
 * and accepts immediately. The caller re-reads the row and verifies its
 * identity before Enter.
 */
async function highlightPickerRow(
  pane: HarnessSubagentPane,
  targetIndex: number,
  wait: (ms: number) => number,
): Promise<string> {
  let screen = await pane.read();
  let row = highlightedPickerRow(screen);
  if (!row) throw new Error("Codex didn't highlight a row in its picker.");
  while (row.index !== targetIndex) {
    const previous = row.index;
    await pane.type(previous < targetIndex ? PICKER_DOWN : PICKER_UP);
    screen = await waitForScreen(
      pane,
      (next) => !hasPicker(next) || (highlightedPickerRow(next)?.index ?? previous) !== previous,
      wait(1500),
    );
    if (!hasPicker(screen)) throw new Error("Codex closed its agent picker before selecting.");
    row = highlightedPickerRow(screen);
    if (!row) throw new Error("Codex didn't highlight a row in its picker.");
    if (row.index === previous) throw new Error("Codex didn't move its picker highlight.");
  }
  return screen;
}

/**
 * Codex keeps its agent picker entirely inside the TUI. Read the pane, send
 * the picker's own keys, then read it back to confirm the view actually moved.
 * Completed children remain in the list, so the target is chosen by the id
 * printed on its row, never by the server roster's position. A narrow pane
 * hides that id column, and there the row's printed name is the identity;
 * two rows sharing it are refused rather than guessed. Rows 1-9 are picked by
 * their painted number, which Codex accepts immediately; deeper rows are
 * paged and arrowed.
 */
async function selectCodexSubagent(input: HarnessSubagentSelectInput): Promise<HarnessSubagentSelectResult> {
  const { agentId, agents, pane } = input;
  const target = agentId === null ? null : pickerTarget(agentId, agents);
  const deadline = Date.now() + 20_000;
  const wait = (ms: number) => Math.max(0, Math.min(ms, deadline - Date.now()));
  let screen = await pane.read();
  // Codex disables direct input while a child view is showing, and a command
  // typed there never opens the picker. Alt+Left cycles agent views; walk
  // back until Main's status line is on screen. This touches no prompt text.
  // An open picker is the picker wherever it was opened from: Alt+Left moves
  // its highlight, never the agent view, so stop walking once it is visible.
  for (let i = 0; i < 64 && Date.now() < deadline && !hasPicker(screen) && !isMainView(screen); i++) {
    await pane.type(ALT_LEFT);
    await new Promise((resolve) => setTimeout(resolve, COMMAND_SETTLE_MS));
    screen = await pane.read();
  }
  if (!hasPicker(screen) && !isMainView(screen)) {
    throw new Error("Codex is showing a subagent and didn't return to Main.");
  }
  if (agentId === null && !hasPicker(screen) && isMainView(screen)) {
    return { selectedId: null };
  }
  let openedPicker = false;
  if (!hasPicker(screen)) {
    // Only outside the picker: its `›` row would read as composer text.
    if (composerText(screen)) {
      throw new Error("Finish or clear the prompt before switching agents.");
    }
    await typeCommand(pane, "/subagents");
    openedPicker = true;
    screen = await waitForScreen(pane, hasPicker, wait(3000));
  }
  try {
    screen = await revealPickerRow(pane, target, screen, wait);
    const index = pickerIndex(screen, target);
    if (index === undefined) throw new Error("Codex didn't list that subagent in its picker.");
    const row = paintedPickerRows(screen).find((candidate) => candidate.index === index);
    if (row === undefined) throw new Error("Codex didn't list that subagent in its picker.");
    if (target === null ? !/^\s*Main\s*\[default\]/.test(row.label) : !pickerRowMatches(row, target)) {
      throw new Error("Codex listed a different row for that subagent.");
    }
    if (index <= 9) {
      // Codex's picker picks rows 1-9 by their painted number and accepts
      // immediately. That is the one direct jump the TUI offers; deeper rows
      // have only paging and arrows.
      await pane.type(String(index));
    } else {
      screen = await highlightPickerRow(pane, index, wait);
      const highlighted = highlightedPickerRow(screen);
      if (highlighted === undefined) throw new Error("Codex didn't highlight a row in its picker.");
      if (
        target === null ? !/^\s*Main\s*\[default\]/.test(highlighted.label) : !pickerRowMatches(highlighted, target)
      ) {
        throw new Error("Codex highlighted a different row in its picker.");
      }
      await pane.type("\r");
    }
    screen = await waitForPickerClosed(pane, wait(3000));
    if (agentId === null ? !isMainView(screen) : isMainView(screen)) {
      throw new Error("Codex didn't switch to the selected agent.");
    }
    return { selectedId: agentId };
  } catch (err) {
    // If this act opened the picker, don't leave it covering the pane after a
    // failure: the user asked to change views, not to browse the menu.
    if (openedPicker) {
      const current = await pane.read().catch(() => undefined);
      if (current && hasPicker(current)) await pane.type(ESCAPE);
    }
    throw err;
  }
}

/**
 * Built-in harness: Codex (OpenAI's `@openai/codex` CLI).
 *
 * Launch shape:
 *   codex [-m <model>] [-s <sandbox>] [-a <approval>] [mcp -c pairs]
 *         [preset flags] [extra flags]
 * A bare launch (no subcommand, no prompt) opens the interactive TUI. Codex
 * has no create-time flag for naming its own session and no way to pin a
 * conversation id, so neither the subshell name nor a resume capability is
 * forwarded — restarts start a fresh conversation (the documented default).
 * The pane's
 * cwd is already the working directory, so `-C/--cd` is never passed, and
 * `--dangerously-bypass-approvals-and-sandbox` is NEVER baked into a launch
 * (a user may put it in their own preset flags — that is their call).
 *
 * subshell MCP is wired automatically WITHOUT touching user state: every
 * launch carries `-c mcp_servers.subshell.command=…`,
 * `-c mcp_servers.subshell.args=…` and `-c mcp_servers.subshell.env_vars=…`
 * config overrides (dotted path, value parsed as TOML — verified against the
 * real binary), which codex merges over ~/.codex/config.toml for that run
 * only. The subagent monitoring hooks ride the same mechanism as
 * `hooks.SubagentStart/SubagentStop/SessionStart` overrides, so a user's own
 * `hooks.*` table is REPLACED for the duration of a subshell-launched run —
 * the documented limitation, same shape as claude-code's; nothing on disk
 * changes. No config file the harness must read, no CODEX_HOME redirect (that
 * dir holds the user's auth.json). The spawned `subshell mcp` child needs the
 * pane's SUBSHELL_* identity, and Codex filters a child's environment, so the
 * env_vars override re-forwards those names (never values) at each launch.
 * (Flags/values verified against @openai/codex 2026-09 help output.)
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (host: PluginHost): SubshellPlugin => ({
  subagents: {
    discovery: "hooks",
    navigation: "native",
    setup:
      "Review the Subshell subagent monitoring hooks in /hooks and trust them to show active subagents in the sidebar.",
    select: selectCodexSubagent,
  },
  capabilities: (): PluginCapability[] => ["subagents", "mcp", "settings"],

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, preset, extraFlags, mcp } = input;
    const args: string[] = [binary];
    if (input.reporter) {
      const command = [input.reporter.command, ...input.reporter.args, "subagents"].map(host.shellQuote).join(" ");
      for (const event of ["SubagentStart", "SubagentStop", "SessionStart", "PostToolUse"]) {
        args.push(
          "-c",
          `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},statusMessage="Subshell subagent monitoring",timeout=2}]}]`,
        );
      }
    }

    const s = preset.settings ?? {};
    if (typeof s.model === "string" && s.model) args.push("-m", s.model);
    if (typeof s.sandbox === "string" && s.sandbox) args.push("-s", s.sandbox);
    if (typeof s.askForApproval === "string" && s.askForApproval) args.push("-a", s.askForApproval);

    // Subshell channels + subshell orchestration: the registration's own argv
    // (-c mcp_servers.subshell.* overrides — see mcpRegistration) splices here.
    if (mcp?.args) args.push(...mcp.args);

    // Each stored flag is one complete argv token (row editor guarantees it);
    // never re-split on whitespace or multi-word values break.
    for (const flag of preset.flags) args.push(flag);

    if (extraFlags) args.push(...extraFlags);
    return args;
  },

  /**
   * Codex config fragment registering subshell as a stdio MCP server — the
   * exact `[mcp_servers.subshell]` block `~/.codex/config.toml` expects. The
   * block is NOT what activates the server on subshell launches: `buildCommand`
   * splices live `-c` overrides instead (see the module doc), so this file is a
   * manual-setup reference a user may append to their own config.
   */
  mcpRegistration(launch: McpLaunchSpec, _configPath: string): McpRegistration {
    const fragment = [
      "# Subshell: cross-subshell MCP server, in the shape ~/.codex/config.toml expects.",
      "#",
      "# This file is a MANUAL-SETUP REFERENCE ONLY: subshell's own launches pass the",
      "# live values as `-c mcp_servers.subshell.*=…` per-invocation overrides, so codex",
      "# never reads this file. To register subshell permanently (e.g. terminal codex),",
      "# append the block below to ~/.codex/config.toml.",
      "",
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `command = ${tomlString(launch.command)}`,
      `args = ${tomlStringArray(launch.args)}`,
      `env_vars = ${tomlStringArray(MCP_ENV_VARS)}`,
      "",
    ].join("\n");
    return {
      fileContent: fragment,
      args: [
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(launch.command)}`,
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.args=${tomlStringArray(launch.args)}`,
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.env_vars=${tomlStringArray(MCP_ENV_VARS)}`,
      ],
      // No wiring env on purpose (contrast opencode's OPENCODE_CONFIG): the -c
      // argv IS the wiring, and CODEX_HOME must stay on the user's dir (auth).
      // env_vars explicitly forwards the pane identity to the MCP child.
      env: undefined,
    };
  },

  /** Auto: `buildCommand` wires `-c mcp_servers.subshell.*` into every subshell. */
  mcpSetup(_launch: McpLaunchSpec): McpSetupInfo {
    return {
      mode: "auto",
      summary:
        "Subshell registers itself with every Codex subshell automatically (per-invocation -c mcp_servers.subshell.* overrides; your ~/.codex config is never modified). The same overrides carry the subagent monitoring hooks, so a hooks.* you set in ~/.codex is replaced FOR THAT RUN only, and nothing on disk changes.",
    };
  },

  validatePreset(preset: PresetDefinition): PresetValidationResult {
    return validateGenericPreset(preset);
  },

  presetSettings(): SettingsField[] {
    return CODEX_SETTINGS_FIELDS;
  },

  suggestedEnv(): { key: string; description: string }[] {
    return SUGGESTED_ENV;
  },

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";

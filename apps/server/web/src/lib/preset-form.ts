import type { PresetRow } from "@/types/preset";

/** One env var as edited: name and value in separate fields. */
export interface EnvRow {
  /** Variable name, e.g. "ANTHROPIC_MODEL" ("" = untouched placeholder row) */
  key: string;
  /** Raw value as typed */
  value: string;
}

/** One CLI flag as edited; an empty value renders as a bare flag. */
export interface FlagRow {
  /** The flag token, e.g. "--model" ("" = untouched placeholder row) */
  flag: string;
  /**
   * The flag's value kept as ONE argv token — spaces inside are deliberate
   * (e.g. the text for `--append-system-prompt`), never re-split.
   */
  value: string;
}

/**
 * Live form state shared by the preset create dialog and edit page. Rows are
 * the source of truth; conversion to the API's env object / flag token array
 * happens only on submit.
 */
export interface PresetFormValue {
  /** Harness this preset configures; fixed once the preset exists */
  harnessId: string;
  name: string;
  envRows: EnvRow[];
  flagRows: FlagRow[];
  restartOnExit: boolean;
}

/**
 * Empty form state — one blank row per section so typing can start
 * immediately, and auto-restart ON (operator's call, 2026-09-18).
 *
 * A preset exists because someone means to run this agent this way more than
 * once, and an agent that exits on its own is nearly always something to
 * recover from rather than a decision to be asked about later. The switch
 * stays, so turning it off is one click; it is the DEFAULT that moved, and
 * only for a form being filled in — {@link presetFormFromRow} still reads
 * every existing preset's own stored value, so nothing already saved changes.
 */
export function emptyPresetForm(): PresetFormValue {
  return {
    harnessId: "",
    name: "",
    envRows: [{ key: "", value: "" }],
    flagRows: [{ flag: "", value: "" }],
    restartOnExit: true,
  };
}

/**
 * Seeds a form from a preset row: env object entries become rows, and the
 * flat flag token array is paired back into rows (each `-`-prefixed token
 * starts a row; the tokens until the next flag form its value).
 */
export function presetFormFromRow(row: PresetRow): PresetFormValue {
  let env: Record<string, string> = {};
  if (row.envJson) {
    try {
      env = JSON.parse(row.envJson) as Record<string, string>;
    } catch {
      // Corrupt stored JSON — start with one blank row rather than throwing.
      env = {};
    }
  }
  let tokens: string[] = [];
  if (row.flagsJson) {
    try {
      tokens = JSON.parse(row.flagsJson) as string[];
    } catch {
      // Corrupt stored JSON — fall back to no flags rather than throwing.
      tokens = [];
    }
  }
  const envRows = Object.entries(env).map(([key, value]) => ({ key, value: String(value ?? "") }));
  return {
    harnessId: row.harnessId,
    name: row.name,
    envRows: envRows.length > 0 ? envRows : [{ key: "", value: "" }],
    flagRows: flagTokensToRows(tokens),
    restartOnExit: row.restartOnExit === 1,
  };
}

/**
 * Pairs flat argv tokens ("--model", "sonnet", "--verbose") into editor rows,
 * each `-`-prefixed token opening a row and subsequent tokens joining its
 * value. Tokens before the first flag (e.g. an accidentally stored binary
 * name) are dropped.
 */
export function flagTokensToRows(tokens: string[]): FlagRow[] {
  const rows: FlagRow[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) {
      rows.push({ flag: token, value: "" });
    } else if (rows.length > 0) {
      const last = rows[rows.length - 1];
      last.value = last.value ? `${last.value} ${token}` : token;
    }
  }
  return rows.length > 0 ? rows : [{ flag: "", value: "" }];
}

/** Converts env rows to the API object, skipping rows with no key. */
export function formToEnv(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

/** Converts flag rows to flat argv tokens; empty rows are skipped. */
export function formToFlagTokens(rows: FlagRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const flag = row.flag.trim();
    if (!flag) continue;
    out.push(flag);
    const value = row.value.trim();
    if (value) out.push(value);
  }
  return out;
}

/** API body for `POST /api/presets` — see {@link toPresetPayload}. */
export interface PresetPayload {
  /** Harness the preset configures (the form's pre-check makes empty impossible) */
  harnessId: string;
  /** Preset name; blank input falls back to "Untitled" */
  name: string;
  /** Env vars, empty-key rows dropped */
  env: Record<string, string>;
  /** Flat argv tokens built from the flag rows */
  flags: string[];
  /** Reserved for future per-preset settings; no consumer reads it yet */
  settings: Record<string, never>;
  /** Always false: no harness consumes config isolation yet — see preset-fields.tsx. */
  configIsolation: boolean;
  /** Whether the supervisor restarts the subshell when the harness exits */
  restartOnExit: boolean;
}

/**
 * Builds the exact `POST /api/presets` body from live form state —
 * extracted verbatim from the create dialog so no second creator can fork
 * the payload (the repeated "no config isolation yet" constant and the
 * `"Untitled"` fallback included).
 * @param form - The live preset form state
 * @returns The request body, ready to `JSON.stringify`
 */
export function toPresetPayload(form: PresetFormValue): PresetPayload {
  return {
    harnessId: form.harnessId,
    name: form.name.trim() || "Untitled",
    env: formToEnv(form.envRows),
    flags: formToFlagTokens(form.flagRows),
    settings: {},
    // No harness consumes config isolation yet — see preset-fields.tsx.
    configIsolation: false,
    restartOnExit: form.restartOnExit,
  };
}

/** API body for `PUT /api/presets/:id` — see {@link toPresetUpdatePayload}. */
export interface PresetUpdatePayload {
  /** Preset name; blank input falls back to "Untitled" */
  name: string;
  /** Env vars, empty-key rows dropped */
  env: Record<string, string>;
  /** Flat argv tokens built from the flag rows */
  flags: string[];
  /** Always false: no harness consumes config isolation yet — see preset-fields.tsx. */
  configIsolation: boolean;
  /** Whether the supervisor restarts the subshell when the harness exits */
  restartOnExit: boolean;
}

/**
 * Builds the exact `PUT /api/presets/:id` body from live form state —
 * {@link toPresetPayload} MINUS `harnessId` (a preset's harness is fixed at
 * creation and the API never reassigns it) and `settings` (the update contract
 * has no such field; nothing reads it yet anyway). A separate builder rather
 * than an option flag on the POST one: the two bodies differ in shape, and a
 * union-typed return would force every caller to delete keys it must not
 * send.
 * @param form - The live preset form state
 * @returns The request body, ready to `JSON.stringify`
 */
export function toPresetUpdatePayload(form: PresetFormValue): PresetUpdatePayload {
  return {
    name: form.name.trim() || "Untitled",
    env: formToEnv(form.envRows),
    flags: formToFlagTokens(form.flagRows),
    // No harness consumes config isolation yet — see preset-fields.tsx.
    configIsolation: false,
    restartOnExit: form.restartOnExit,
  };
}

/**
 * Parses bulk-pasted env vars into rows. Accepts a JSON object or a mix of
 * `KEY=value`, `export KEY=value`, and `set KEY=value` lines; blank lines and
 * `#` comments are ignored. A trailing `\` (shell line continuation, as seen
 * in pasted `FOO=bar \` command prefixes) is dropped — each line still stands
 * on its own. Throws on a line that isn't a `KEY=value` pair — the caller
 * shows the message without touching existing rows.
 */
export function parseEnvPaste(text: string): EnvRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new Error("That doesn't look like a JSON object");
    }
    return Object.entries(parsed).map(([key, value]) => ({ key, value: String(value) }));
  }
  const rows: EnvRow[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    let line = rawLine.trim();
    // Shell continuation marker: drop one trailing `\`, but leave `\\`
    // (an escaped literal backslash, e.g. at the end of a Windows path).
    if (line.endsWith("\\") && !line.endsWith("\\\\")) line = line.slice(0, -1).trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.replace(/^(export|set)\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) throw new Error(`Not a KEY=value line: "${line}"`);
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid variable name: "${key}"`);
    rows.push({ key, value: unquote(withoutExport.slice(eq + 1).trim()) });
  }
  return rows;
}

/**
 * Parses bulk-pasted CLI flags into rows. Accepts one flag per line or a
 * whole command line, including one wrapped with `\` shell continuations; a
 * tiny quote-aware tokenizer keeps `"be nice"` inside one value. Tokens
 * starting with `-` open a row, the rest join its value; anything before the
 * first flag (a pasted binary name) and a leading `--` separator are dropped.
 */
export function parseFlagsPaste(text: string): FlagRow[] {
  const tokens = tokenize(text);
  const rows: FlagRow[] = [];
  let first = true;
  for (const token of tokens) {
    if (first && token === "--") continue;
    if (token.startsWith("-")) {
      rows.push({ flag: token, value: "" });
      first = false;
    } else if (rows.length > 0) {
      const last = rows[rows.length - 1];
      last.value = last.value ? `${last.value} ${token}` : token;
    }
  }
  return rows;
}

/** Splits on whitespace, honouring single/double quotes and `\"` escapes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (quote === '"' && c === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (c === "\\" && (input[i + 1] === "\n" || input[i + 1] === "\r")) {
      // Shell line continuation outside quotes: drop the `\` and the newline
      // without emitting a separator, so a token split across the break
      // glues back together.
      i++;
      if (input[i] === "\r" && input[i + 1] === "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += c;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in pasted text");
  if (started) tokens.push(current);
  return tokens;
}

/** Strips one layer of matching surrounding quotes. */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** What a pasted command line resolves to — see {@link parseCommandPaste}. */
export interface ParsedCommand {
  /** Leading `KEY=value` assignments, in the order they appeared */
  env: EnvRow[];
  /** Everything after the command name, paired the way the flag editor stores it */
  flags: FlagRow[];
  /**
   * The command token as pasted (`claude`, `/usr/local/bin/claude`), or
   * undefined when the text held no command — a bare `--effort xhigh` is a
   * legitimate paste. It is reported so the form can SAY it was ignored;
   * nothing consumes it, because a preset runs the agent it names and the
   * binary is resolved on the pane's own machine.
   */
  command?: string;
}

/**
 * Parses a whole shell command line — the thing you copy out of a terminal —
 * into the preset editor's env and flag rows. The shape is
 * `KEY=value … [env] <command> [flags]`: leading assignments become env rows,
 * the first token that is not an assignment is the command, and the rest pair
 * into flag rows by the same rule {@link parseFlagsPaste} uses.
 *
 * `\` line continuations, single/double quotes and `\"` escapes are handled by
 * the shared tokenizer, so the multi-line form a terminal prints survives a
 * copy-paste intact. An assignment AFTER the command is an argument, not an
 * env var — the walk stops collecting at the first non-assignment token.
 *
 * @param text - Raw pasted text
 * @returns The env rows, flag rows and the ignored command token
 * @throws When a quote is left open (the caller renders the message inline)
 * @example
 * parseCommandPaste('FOO=bar \\\n claude --effort xhigh')
 * // { env: [{key:"FOO",value:"bar"}], flags: [{flag:"--effort",value:"xhigh"}], command: "claude" }
 */
export function parseCommandPaste(text: string): ParsedCommand {
  const tokens = tokenize(text);
  const env: EnvRow[] = [];
  let index = 0;
  // `env FOO=bar cmd` is the other spelling a terminal produces; `export` is
  // not (it is a statement, not a command prefix) and is left to parseEnvPaste.
  if (tokens[index] === "env") index++;
  for (; index < tokens.length; index++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tokens[index]);
    if (!match) break;
    // NOT `unquote`, deliberately (fixed 2026-09-19). The tokenizer has
    // already consumed the shell quoting — `K="a b"` arrives here as the one
    // token `K=a b` — so a second strip would remove a LITERAL pair from the
    // data: `K="'x'"` became `x` rather than `'x'`, and `K="''"` became the
    // empty string. `parseEnvPaste` still calls `unquote` and must, because
    // it splits lines and never tokenizes, so the quotes reach it intact.
    env.push({ key: match[1], value: match[2] });
  }
  const rest = tokens.slice(index);
  // A token that opens a flag is not a command: a paste may be flags alone.
  const command = rest.length > 0 && !rest[0].startsWith("-") ? rest.shift() : undefined;
  const flags: FlagRow[] = [];
  let first = true;
  for (const token of rest) {
    if (first && token === "--") continue;
    if (token.startsWith("-")) {
      flags.push({ flag: token, value: "" });
      first = false;
    } else if (flags.length > 0) {
      const last = flags[flags.length - 1];
      last.value = last.value ? `${last.value} ${token}` : token;
    }
  }
  return command === undefined ? { env, flags } : { env, flags, command };
}

/**
 * Renders live form state back as the command line it stands for — the
 * inverse of {@link parseCommandPaste}, and what the Paste command panel
 * shows when you switch to it. Without this the panel would hold whatever was
 * pasted before, which stops describing the preset the moment a row is edited
 * in the other panel.
 *
 * Empty rows are skipped exactly as {@link toPresetPayload} skips them, so
 * what this prints is what the preset would run.
 *
 * @param form - The live preset form state
 * @param command - Command name to print (the selected agent's binary); a
 *   blank one prints the env assignments alone rather than inventing a name
 * @returns A `\`-continued command line, or "" when there is nothing to run
 */
export function presetFormToCommand(form: PresetFormValue, command: string): string {
  const lines: string[] = [];
  for (const row of form.envRows) {
    const key = row.key.trim();
    if (key) lines.push(`${key}=${shellQuote(row.value)}`);
  }
  const argv: string[] = [];
  for (const row of form.flagRows) {
    const flag = row.flag.trim();
    if (!flag) continue;
    argv.push(flag);
    const value = row.value.trim();
    if (value) argv.push(shellQuote(value));
  }
  // A preset that sets nothing has no command line — printing the bare agent
  // name would fill a fresh form's paste box with `claude` and hide the
  // worked example the placeholder is there to show.
  if (lines.length === 0 && argv.length === 0) return "";
  const name = command.trim();
  if (name) argv.unshift(shellQuote(name));
  if (argv.length > 0) lines.push(argv.join(" "));
  return lines.join(" \\\n");
}

/**
 * Wraps a value in DOUBLE quotes when a shell would otherwise re-split or
 * interpret it, escaping `\` and `"` inside. Only what {@link tokenize}
 * treats as special needs it, so ordinary values stay bare and the rendered
 * line reads like something a person typed.
 *
 * Double rather than the single quotes a shell-quoting helper usually
 * reaches for: the POSIX `'\''` trick for an embedded apostrophe is not
 * something our tokenizer can read back, so a value like `it's mine` would
 * survive a shell and not survive the round trip this function exists for.
 * `"` and `\` escapes ARE read back, and mean the same thing to a real shell.
 */
function shellQuote(value: string): string {
  if (value === "") return '""';
  if (!/[\s'"\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Suggests a clone name for a preset: the source name with the first free
 * numeric suffix — `"<name> (2)"`, `(3)`, …, the convention migration 0028
 * used to break the collisions it found. Taken-ness is scoped to rows of the
 * SAME harness (the UNIQUE index is `(user_id, harness_id, name
 * COLLATE NOCASE)`) and compared case-insensitively, so the suggestion
 * matches what `POST /api/presets` would reject. The loop is bounded because
 * names are unique per harness, so at most `taken.size` candidates can be
 * taken — one more number is always free.
 *
 * @param rows - The caller's preset list (the `usePresets()` cache)
 * @param source - The preset being cloned (its own row never blocks)
 * @returns A name free for this user's preset of the same harness
 */
export function suggestCloneName(rows: PresetRow[], source: PresetRow): string {
  const taken = new Set(
    rows.filter((r) => r.harnessId === source.harnessId && r.id !== source.id).map((r) => r.name.toLowerCase()),
  );
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${source.name} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable while the index holds: taken.size names cannot fill
  // taken.size + 1 candidates.
  return `${source.name} (${taken.size + 2})`;
}

/**
 * The preset editor's paste-parsing and command-rendering machinery: the
 * quote-aware tokenizer, the paste parsers ({@link parseEnvPaste},
 * {@link parseFlagsPaste}, {@link parseCommandPaste}) and the inverse render
 * ({@link presetFormToCommand}). Split out of `preset-form.ts` (which holds
 * the form model and payload builders); imports flow this way only — this
 * module reads the row/form types, `preset-form.ts` never imports this one.
 */
import type { EnvRow, FlagRow, PresetFormValue } from "@/lib/preset-form";

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

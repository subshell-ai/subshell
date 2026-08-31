import type { ProfileRow } from "@/types/profile";

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
 * Live form state shared by the profile create form and edit page. Rows are
 * the source of truth; conversion to the API's env object / flag token array
 * happens only on submit.
 */
export interface ProfileFormValue {
  /** Harness this profile configures; fixed once the profile exists */
  harnessId: string;
  name: string;
  envRows: EnvRow[];
  flagRows: FlagRow[];
  restartOnExit: boolean;
}

/** Empty form state — one blank row per section so typing can start immediately. */
export function emptyProfileForm(): ProfileFormValue {
  return {
    harnessId: "",
    name: "",
    envRows: [{ key: "", value: "" }],
    flagRows: [{ flag: "", value: "" }],
    restartOnExit: false,
  };
}

/**
 * Seeds a form from a profile row: env object entries become rows, and the
 * flat flag token array is paired back into rows (each `-`-prefixed token
 * starts a row; the tokens until the next flag form its value).
 */
export function profileFormFromRow(row: ProfileRow): ProfileFormValue {
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

/** API body for `POST /api/profiles` — see {@link toProfilePayload}. */
export interface ProfilePayload {
  /** Harness the profile configures (the form's pre-check makes empty impossible) */
  harnessId: string;
  /** Profile name; blank input falls back to "Untitled" */
  name: string;
  /** Env vars, empty-key rows dropped */
  env: Record<string, string>;
  /** Flat argv tokens built from the flag rows */
  flags: string[];
  /** Reserved for future per-profile settings; no consumer reads it yet */
  settings: Record<string, never>;
  /** Always false: no harness consumes config isolation yet — see profile-fields.tsx. */
  configIsolation: boolean;
  /** Whether the supervisor restarts the session when the harness exits */
  restartOnExit: boolean;
}

/**
 * Builds the exact `POST /api/profiles` body from live form state —
 * extracted verbatim from the create form so the wizard and any future
 * creator can't fork the payload (the repeated "no config isolation yet"
 * constant and the `"Untitled"` fallback included).
 * @param form - The live profile form state
 * @returns The request body, ready to `JSON.stringify`
 */
export function toProfilePayload(form: ProfileFormValue): ProfilePayload {
  return {
    harnessId: form.harnessId,
    name: form.name.trim() || "Untitled",
    env: formToEnv(form.envRows),
    flags: formToFlagTokens(form.flagRows),
    settings: {},
    // No harness consumes config isolation yet — see profile-fields.tsx.
    configIsolation: false,
    restartOnExit: form.restartOnExit,
  };
}

/** API body for `PUT /api/profiles/:id` — see {@link toProfileUpdatePayload}. */
export interface ProfileUpdatePayload {
  /** Profile name; blank input falls back to "Untitled" */
  name: string;
  /** Env vars, empty-key rows dropped */
  env: Record<string, string>;
  /** Flat argv tokens built from the flag rows */
  flags: string[];
  /** Always false: no harness consumes config isolation yet — see profile-fields.tsx. */
  configIsolation: boolean;
  /** Whether the supervisor restarts the session when the harness exits */
  restartOnExit: boolean;
}

/**
 * Builds the exact `PUT /api/profiles/:id` body from live form state —
 * {@link toProfilePayload} MINUS `harnessId` (a profile's harness is fixed at
 * creation and the API never reassigns it) and `settings` (the update contract
 * has no such field; nothing reads it yet anyway). A separate builder rather
 * than an option flag on the POST one: the two bodies differ in shape, and a
 * union-typed return would force every caller to delete keys it must not
 * send. Extracted verbatim from the edit page so a future update surface
 * can't fork the body.
 * @param form - The live profile form state
 * @returns The request body, ready to `JSON.stringify`
 */
export function toProfileUpdatePayload(form: ProfileFormValue): ProfileUpdatePayload {
  return {
    name: form.name.trim() || "Untitled",
    env: formToEnv(form.envRows),
    flags: formToFlagTokens(form.flagRows),
    // No harness consumes config isolation yet — see profile-fields.tsx.
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

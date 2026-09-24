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
 * The API's cap on a preset name — mirrors `name.maxLength: 120` in
 * `CreatePresetBodySchema` (`apps/server/api/src/api/presets.route.ts`). A
 * clone suggestion the server can only reject is worse than a shorter name.
 */
const MAX_PRESET_NAME = 120;

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
 * @returns A name free for this user's preset of the same harness, at most
 *   {@link MAX_PRESET_NAME} characters: a source base longer than that is
 *   trimmed so base + ` (${n})` still fits what `POST /api/presets` accepts
 */
export function suggestCloneName(rows: PresetRow[], source: PresetRow): string {
  const taken = new Set(
    rows.filter((r) => r.harnessId === source.harnessId && r.id !== source.id).map((r) => r.name.toLowerCase()),
  );
  // The candidate is built per n: the suffix length rides the number, so a
  // two-digit n trims the base one character further than a one-digit one.
  const candidateFor = (n: number): string => {
    const suffix = ` (${n})`;
    return source.name.slice(0, MAX_PRESET_NAME - suffix.length) + suffix;
  };
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = candidateFor(n);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable while the index holds: taken.size names cannot fill
  // taken.size + 1 candidates.
  return candidateFor(taken.size + 2);
}

/**
 * The configure form's pure half: which fields it draws, how they are seeded
 * from `status --json`, and what a save sends.
 *
 * Separate from `main.ts` because this is the part with a contract rather than
 * a rendering. A save is a NON-INTERACTIVE `subshell-server init --yes`, and
 * `configure` resolves every key it was given no flag for to that key's STORED
 * value — so what this form does or does not send decides whether a save
 * preserves the file or rewrites it. Both ways of getting it wrong are silent.
 */
import type { SettingEntry } from "./ipc";

/** The form's four state keys; also the payload keys Rust reads. */
export type FormName = "port" | "host" | "baseUrl" | "trustedOrigins";

/** One row of the form. */
export interface ConfigField {
  name: FormName;
  label: string;
  /** The `status --json` settings key this row seeds from. */
  settingKey: string;
  /** Stands in for "the CLI's own default" — HINT TEXT only, never sent. */
  placeholder: string;
  numeric?: boolean;
  /** Whether the input PREFILLS from the stored value. `trustedOrigins` opts out. */
  prefill?: boolean;
  /** Full-width row: a URL and an origin list do not fit half a two-column grid. */
  wide?: boolean;
  hint?: string;
}

/** A `status`-reported problem with one stored entry. */
export interface SettingProblem {
  entry: string;
  reason: string;
}

/** The form's values, held as strings because they arrive from inputs. */
export type FormValues = Record<FormName, string>;

/** Which fields to SEND. Keyed by name; a true value means "someone chose this". */
export type ExplicitMap = Partial<Record<FormName, boolean>>;

/**
 * One row of the form.
 *
 * The placeholders are the CLI's defaults, deliberately duplicated as HINT
 * TEXT only: nothing here is ever SENT, so a drifted placeholder misleads but
 * cannot misconfigure. The real defaults stay in `commands/configure.ts`.
 *
 * `trustedOrigins` is the ONE exception, and deliberately so: its real default
 * is `DEFAULT_TRUSTED_ORIGINS`, the two dev Vite origins, which as a suggestion
 * to a person configuring an instance would be actively misleading. Its
 * placeholder is an EXAMPLE instead, and shows two different SHAPES — one
 * behind a proxy on the scheme's default port, one dialled directly — because
 * a pair that both carried a port read as though a port were part of the
 * format.
 */
export const CONFIG_FIELDS: ConfigField[] = [
  { name: "port", label: "Port", settingKey: "SERVER_PORT", placeholder: "3080", numeric: true, prefill: true },
  // Blank inherits the CLI default, which since 2026-09-07 is 0.0.0.0 — a
  // loopback bind is unreachable from every other machine, and remote nodes
  // and devices are the point of a control plane. Type 127.0.0.1 to opt out.
  { name: "host", label: "Bind address", settingKey: "HOST", placeholder: "0.0.0.0", prefill: true },
  {
    name: "baseUrl",
    label: "Public base URL",
    settingKey: "APP_BASE_URL",
    prefill: true,
    placeholder: "http://localhost:3080",
    wide: true,
    hint: "The address browsers, phones and remote nodes dial. Passkeys are tied to this host.",
  },
  {
    name: "trustedOrigins",
    // Deliberately NOT prefilled: its default is the two dev Vite origins,
    // which would be a bizarre thing to write into a real instance's config.
    label: "Other addresses browsers will use (optional)",
    settingKey: "TRUSTED_ORIGINS",
    // Two SHAPES, not two hosts: one behind a proxy on the scheme's default
    // port (so no port at all) and one dialled directly. A pair that both
    // carried `:3080` read as though a port were part of the format.
    placeholder: "https://subshell.example.com, http://10.0.0.5:3080",
    wide: true,
    // The FORMAT only. Four more sentences lived here — no wildcards, when a
    // port belongs, what an unlisted address fails with, that loopback is
    // free — and they turned a hint under one optional field into the longest
    // block on the screen. The placeholder above already shows both shapes,
    // and `validateValue` refuses a wildcard with its own message at the
    // moment it matters; a rule nobody is breaking yet is reference material,
    // not a caption (docs/security.md, "Which addresses a browser may use").
    hint: "One full address per entry, comma-separated.",
  },
];

/**
 * Every field's EFFECTIVE value, for display: what the server would boot with,
 * whether someone chose it or the CLI derived it.
 *
 * This is what the inputs show, so the form states the configuration instead
 * of leaving the reader to notice greyed placeholder text. It is deliberately
 * NOT what gets sent: see {@link configPayload}, which still expresses "let
 * the CLI keep deriving this" as an empty value, now keyed on whether the
 * field was edited rather than on whether it was blank.
 *
 * Only `prefill` fields are filled in. `trustedOrigins` is excluded because
 * its default is `DEFAULT_TRUSTED_ORIGINS`, the two dev Vite origins.
 */
export function effectiveForm(settings: Record<string, SettingEntry> | undefined): FormValues {
  return Object.fromEntries(
    CONFIG_FIELDS.map((field) => {
      const setting = settings?.[field.settingKey];
      if (!field.prefill) return [field.name, setting?.source === "default" ? "" : (setting?.value ?? "")];
      return [field.name, setting?.value ?? ""];
    }),
  ) as FormValues;
}

/**
 * The CLI's own derivation of `APP_BASE_URL` from a port.
 *
 * Duplicated here so a prefilled base URL can FOLLOW the port while nobody has
 * edited it. Without that, changing the port to 4000 would leave a filled
 * field reading `http://localhost:3080`, which looks like the value that is
 * about to be saved. The save itself is safe either way (an untouched field is
 * sent empty), but a field that shows a stale value is the trap this form
 * exists to close, not one to reopen.
 */
export function derivedBaseUrl(port: string): string {
  return `http://localhost:${(port ?? "").trim() || "3080"}`;
}

/**
 * Where the dashboard will answer, given what the form currently holds.
 *
 * The Set Up screen's URL row is this one rule: a chosen `APP_BASE_URL`
 * outranks the port (that is what the save does with it), and with no chosen
 * address the CLI's own derivation rules, so the row follows the port while
 * someone types it. Callers pass the EFFECTIVE values — the form's field if it
 * holds one, else what `status --json` reports — because the form may never
 * have been opened on this machine.
 */
export function dashboardUrl(baseUrl: string, port: string): string {
  const chosen = (baseUrl ?? "").trim();
  return chosen || derivedBaseUrl(port);
}

/**
 * Which fields must be SENT rather than left to the CLI, before any editing.
 *
 * A field whose value came from `config.env` or a real environment variable
 * was chosen by somebody, so a save that did not touch it must send it back:
 * `trustedOrigins` is emptyable, and an empty one means "no extra addresses",
 * so omitting a stored list WIPES it. A `default`-sourced field is the
 * opposite: sending its derived value pins it, and pinning a derived
 * `APP_BASE_URL` is the stale-port failure this form exists to prevent.
 *
 * The form's input handler adds to this as the user types, so it ends up
 * meaning "chosen before, or chosen now".
 */
export function explicitFields(settings: Record<string, SettingEntry> | undefined): ExplicitMap {
  const out: ExplicitMap = {};
  for (const field of CONFIG_FIELDS) {
    const setting = settings?.[field.settingKey];
    if (setting && setting.source !== "default" && (setting.value ?? "") !== "") out[field.name] = true;
  }
  return out;
}

/**
 * The problems `status --json` reports for one form field's key.
 *
 * The reason `status` carries these as DATA rather than as a rendered line:
 * the diagnosis belongs next to the field being edited, not only in the output
 * block at the bottom of the window. A schemeless origin or a base URL that
 * silently drops the instance's own origin is invisible otherwise — the boot
 * accepts both.
 *
 * Possibly empty, never undefined.
 */
export function fieldProblems(settings: Record<string, SettingEntry> | undefined, name: string): SettingProblem[] {
  const field = CONFIG_FIELDS.find((f) => f.name === name);
  if (!field) return [];
  const problems = settings?.[field.settingKey]?.problems;
  return problems ? [...problems] : [];
}

/**
 * The `desktop_init` payload for the form's current values.
 *
 * Every field is sent every time, because an omitted flag means "keep what is
 * on disk" and a form the user just edited means the opposite. The Rust side
 * turns an empty `port`/`host`/`baseUrl` into an omitted flag (the CLI refuses
 * an empty value for those, and omitting correctly falls back to its default),
 * while `trustedOrigins` is passed through even when empty. That is the ONE
 * emptyable flag, and it is how "no extra addresses" is expressed at all.
 *
 * **`explicit` is what keeps a derived value from being pinned.** The fields
 * are prefilled now (see {@link effectiveForm}), so blankness can no longer
 * mean "nobody chose this"; this map does. A field nobody chose is sent EMPTY,
 * which the Rust side turns into an omitted flag so the CLI keeps deriving it.
 * Pinning a derived `APP_BASE_URL` is the specific failure that matters for:
 * it is derived from the port, so writing `http://localhost:3080` into
 * config.env leaves a base URL naming a dead port after the next port change,
 * and an allowlist built around the wrong origin.
 *
 * A field that WAS chosen is sent even when untouched, because omitting a
 * stored `trustedOrigins` would clear it. See {@link explicitFields}.
 *
 * Omitting `explicit` sends every field, which is right for a caller with no
 * tracking of its own.
 */
export function configPayload(
  form: Partial<FormValues>,
  explicit?: ExplicitMap,
): { port: string; host: string; baseUrl: string; trustedOrigins: string } {
  const value = (name: FormName): string => {
    if (explicit && explicit[name] !== true) return "";
    return (form?.[name] ?? "").trim();
  };
  return {
    port: value("port"),
    host: value("host"),
    baseUrl: value("baseUrl"),
    trustedOrigins: value("trustedOrigins"),
  };
}

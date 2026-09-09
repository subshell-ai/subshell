/**
 * The configure form's pure half: which fields it draws, how they are seeded
 * from `status --json`, and what a save sends.
 *
 * Separate from `main.js` because this is the part with a contract rather than
 * a rendering. A save is a NON-INTERACTIVE `subshell-server init --yes`, and
 * `configure` resolves every key it was given no flag for to that key's STORED
 * value — so what this form does or does not send decides whether a save
 * preserves the file or rewrites it. Both ways of getting it wrong are silent.
 */

/**
 * One row of the form: the state key, its label, the `status --json` settings
 * key it seeds from, and the placeholder that stands in for "the CLI's own
 * default". `wide` rows get the full width — a URL and a comma-separated list
 * do not fit half of a two-column grid.
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
export const CONFIG_FIELDS = [
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
    hint: "One full address per entry, comma-separated. Name each one exactly; no wildcards. Include a port only if the address uses one; behind a reverse proxy on 443 there is none. Sign-in from an address that is not listed here (or above) fails with “Invalid origin”. Loopback is always allowed.",
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
 *
 * @param {Record<string, {value?: string, source?: string}> | undefined} settings
 * @returns {{port: string, host: string, baseUrl: string, trustedOrigins: string}}
 */
export function effectiveForm(settings) {
  return Object.fromEntries(
    CONFIG_FIELDS.map((field) => {
      const setting = settings?.[field.settingKey];
      if (!field.prefill) return [field.name, setting?.source === "default" ? "" : (setting?.value ?? "")];
      return [field.name, setting?.value ?? ""];
    }),
  );
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
 *
 * @param {string} port
 * @returns {string}
 */
export function derivedBaseUrl(port) {
  return `http://localhost:${(port ?? "").trim() || "3080"}`;
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
 *
 * @param {Record<string, {value?: string, source?: string}> | undefined} settings
 * @returns {Record<string, boolean>}
 */
export function explicitFields(settings) {
  const out = Object.create(null);
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
 * @param {Record<string, {problems?: {entry: string, reason: string}[]}> | undefined} settings
 *   `probe.status.settings`.
 * @param {string} name - a `CONFIG_FIELDS` field name.
 * @returns {{entry: string, reason: string}[]} possibly empty, never undefined.
 */
export function fieldProblems(settings, name) {
  const field = CONFIG_FIELDS.find((f) => f.name === name);
  if (!field) return [];
  return settings?.[field.settingKey]?.problems ?? [];
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
 *
 * @param {{port?: string, host?: string, baseUrl?: string, trustedOrigins?: string}} form
 * @param {Record<string, boolean>} [explicit]
 *   Fields chosen before or typed now. Absent = treat all as chosen.
 * @returns {{port: string, host: string, baseUrl: string, trustedOrigins: string}}
 */
export function configPayload(form, explicit) {
  const value = (name) => {
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

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
  { name: "port", label: "Port", settingKey: "SERVER_PORT", placeholder: "3080", numeric: true },
  // Blank inherits the CLI default, which since 2026-09-07 is 0.0.0.0 — a
  // loopback bind is unreachable from every other machine, and remote nodes
  // and devices are the point of a control plane. Type 127.0.0.1 to opt out.
  { name: "host", label: "Bind address", settingKey: "HOST", placeholder: "0.0.0.0" },
  {
    name: "baseUrl",
    label: "Public base URL",
    settingKey: "APP_BASE_URL",
    placeholder: "http://localhost:3080",
    wide: true,
    hint: "The address browsers, phones and remote nodes dial. Passkeys are tied to this host.",
  },
  {
    name: "trustedOrigins",
    label: "Other addresses browsers will use",
    settingKey: "TRUSTED_ORIGINS",
    // Two SHAPES, not two hosts: one behind a proxy on the scheme's default
    // port (so no port at all) and one dialled directly. A pair that both
    // carried `:3080` read as though a port were part of the format.
    placeholder: "https://subshell.example.com, http://10.0.0.5:3080",
    wide: true,
    hint: "One full address per entry, comma-separated — each named exactly, no wildcards. Include a port only if the address uses one; behind a reverse proxy on 443 there is none. Sign-in from an address that is not listed here (or above) fails with “Invalid origin”. Loopback is always allowed.",
  },
];

/**
 * The form's values for a `status --json` settings map.
 *
 * A key is seeded only when someone CHOSE its value — `config.env` or a real
 * environment variable. A `default`-sourced value is left blank so the field
 * shows its placeholder and the CLI keeps deriving it.
 *
 * That distinction is the one that matters. `status` reports the value the
 * server would boot with, so `APP_BASE_URL` always has one; seeding it would
 * write `http://localhost:<old port>` into config.env on the next save, and a
 * later port change would then leave a base URL naming a port nothing listens
 * on — an allowlist built around the wrong origin, which is the failure this
 * form was added to fix.
 *
 * @param {Record<string, {value?: string, source?: string}> | undefined} settings
 *   `probe.status.settings`, or undefined before the first probe lands.
 * @returns {{port: string, host: string, baseUrl: string, trustedOrigins: string}}
 */
export function seedForm(settings) {
  const chosen = (key) => {
    const setting = settings?.[key];
    if (!setting || setting.source === "default") return "";
    return setting.value ?? "";
  };
  return Object.fromEntries(CONFIG_FIELDS.map((field) => [field.name, chosen(field.settingKey)]));
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
 * while `trustedOrigins` is passed through even when empty — that is the ONE
 * emptyable flag, and it is how "no extra addresses" is expressed at all.
 *
 * @param {{port?: string, host?: string, baseUrl?: string, trustedOrigins?: string}} form
 * @returns {{port: string, host: string, baseUrl: string, trustedOrigins: string}}
 */
export function configPayload(form) {
  const value = (name) => (form?.[name] ?? "").trim();
  return {
    port: value("port"),
    host: value("host"),
    baseUrl: value("baseUrl"),
    trustedOrigins: value("trustedOrigins"),
  };
}

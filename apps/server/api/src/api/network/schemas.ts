import { t } from "elysia";

/**
 * The wire shapes for `/api/network` (spec 2026-09-15 § 5.1).
 *
 * Their own module rather than one per route, because the ROW is what four of
 * the six routes are about: the list renders it, a settings write returns the
 * one it changed, and the two streaming routes carry its `status` in their
 * terminal frame. One definition is what keeps the SPA parsing one shape.
 *
 * Every member mirrors a type in `@internal/pane-runtime` — `NetworkStatus`,
 * `NetworkAddress`, `NetworkHint`, `SettingsField`, `PrivilegedStep`,
 * `SupervisorState`. They are restated here rather than derived because
 * TypeBox cannot be generated from a TypeScript type, and the pairing is
 * checked where it matters: the handlers assign the runtime values straight
 * into these shapes, so a contract change that this file has not followed is a
 * type error rather than a silent field drop.
 */

/** One address this server can be reached at over a network. */
export const NetworkAddressSchema = t.Object({
  url: t.String({ description: "Canonical origin — scheme, host, optional port, no path and no trailing slash" }),
  scheme: t.Union([t.Literal("https"), t.Literal("http")], {
    description: "Scheme of `url`, split out so nothing has to re-parse it",
  }),
  label: t.String({ description: "Where the name comes from, for the UI: 'MagicDNS', 'NetBird IP', …" }),
  secureContext: t.Boolean({
    description:
      "Whether a browser treats this origin as a secure context. False is not a claim that the traffic is unencrypted — it says the browser will refuse passkeys, Secure cookies and service workers there",
  }),
});

/** One thing the operator can do next, rendered verbatim. */
export const NetworkHintSchema = t.Object({
  text: t.String({ description: "The sentence, written for a person rather than a log" }),
  command: t.Optional(t.String({ description: "A command to copy, when there is one" })),
  docsUrl: t.Optional(t.String({ description: "Where the vendor documents it" })),
  privileged: t.Optional(
    t.Boolean({
      description:
        "True when the command needs root. The server never runs one: it has no terminal to answer a password prompt, so the UI renders it to copy",
    }),
  ),
});

/** Everything a plugin reports about one network, on every read. */
export const NetworkStatusSchema = t.Object({
  state: t.Union(
    [
      t.Literal("not-installed"),
      t.Literal("daemon-down"),
      t.Literal("needs-privilege"),
      t.Literal("needs-login"),
      t.Literal("joined"),
      t.Literal("published"),
    ],
    {
      description:
        "Where this host stands with this network, as one word. A ladder: each state is reachable only from the one before it",
    },
  ),
  addresses: t.Array(NetworkAddressSchema, {
    description: "Addresses this server is (or would be) reachable at. Empty below `joined`",
  }),
  loginUrl: t.Optional(
    t.String({ description: "A URL a human finishes a login at. Only meaningful with needs-login" }),
  ),
  loginCode: t.Optional(t.String({ description: "A code to type at `loginUrl`, for device flows that use one" })),
  identity: t.Optional(
    t.Object(
      {
        network: t.Optional(t.String({ description: "The network's own name, when it has one" })),
        hostname: t.Optional(t.String({ description: "What this host is called on this network" })),
        version: t.Optional(t.String({ description: "The vendor CLI's version" })),
      },
      { description: "What this host is called on this network, for the UI to display" },
    ),
  ),
  hints: t.Array(NetworkHintSchema, {
    description: "What to do next, in order. Empty when there is nothing to say",
  }),
});

/**
 * One option in a network plugin's settings editor.
 *
 * NOT `models.ts`'s `SettingsFieldSchema`, which is the PRESET editor's and
 * deliberately names four types: this one carries `secret`, whose value the
 * host stores write-only and never returns, plus `required` and `placeholder`,
 * which the preset editor has no use for. Sharing one schema would have put
 * `secret` in the preset editor, where there is no secret store to write to.
 */
export const NetworkSettingsFieldSchema = t.Object({
  key: t.String({ description: "Key into the settings object" }),
  label: t.String({ description: "Property label" }),
  description: t.Optional(t.String({ description: "Short description for the editor" })),
  type: t.Union(
    [t.Literal("string"), t.Literal("boolean"), t.Literal("number"), t.Literal("select"), t.Literal("secret")],
    {
      description:
        "Editor control kind. `secret` is write-only: the value goes to the host's secret store, and reads report only whether one is set",
    },
  ),
  choices: t.Optional(t.Array(t.String({ description: "One choice" }), { description: "Choices when type is select" })),
  required: t.Optional(t.Boolean({ description: "True when the field must be set before the plugin can act" })),
  placeholder: t.Optional(t.String({ description: "Placeholder or example shown in the editor; never a credential" })),
  default: t.Optional(t.Union([t.String(), t.Boolean(), t.Number()], { description: "Default value when unset" })),
});

/** One step an operator must run themselves, because the host may not. */
export const PrivilegedStepSchema = t.Object({
  label: t.String({ description: "What it does, in a few words" }),
  command: t.String({ description: "The command to copy. Usually sudo-prefixed" }),
  docsUrl: t.Optional(t.String({ description: "Where the vendor documents it" })),
  group: t.Optional(
    t.String({
      description:
        "Heading for the alternative this step belongs to. Steps sharing one are a sequence; different groups are ways to arrive at the same place, rendered with an `or` between them",
    }),
  ),
});

/** The host's view of the long-running child it supervises for a plugin. */
export const SupervisorStateSchema = t.Object({
  running: t.Boolean({
    description: "True once the child is up and (if it declared one) has matched its ready pattern",
  }),
  pid: t.Optional(t.Number({ description: "The live child's pid, present whenever a process exists" })),
  since: t.Optional(t.String({ description: "ISO 8601 stamp of the current child's spawn" })),
  restarts: t.Number({ description: "How many times this entry has been respawned since it was armed" }),
  lastExit: t.Optional(
    t.Object(
      {
        code: t.Nullable(t.Number({ description: "Exit code; null means signalled or never spawned" })),
        at: t.String({ description: "ISO 8601 stamp of the exit" }),
      },
      { description: "How the previous child ended, or why one was never started" },
    ),
  ),
  lastLines: t.Array(t.String({ description: "One line the child printed, ANSI stripped" }), {
    description: "The child's most recent output, oldest first",
  }),
});

/**
 * One stored settings value.
 *
 * A plain string for an ordinary field; `{ set }` for a `secret` one, because
 * the host's secret store is write-only by design — a read that could return
 * the value would put a credential in a response body, a log and a browser
 * cache in one move.
 */
export const NetworkSettingValueSchema = t.Union([t.String(), t.Object({ set: t.Boolean() })], {
  description: "The stored value, or `{ set }` for a secret field whose value is never returned",
});

/** One network plugin, as Settings → Networking renders it. */
export const NetworkRowSchema = t.Object({
  id: t.String({ description: "Plugin id (its directory name under the instance's plugins dir)" }),
  name: t.String({ description: "Display name, from the plugin's manifest" }),
  description: t.String({ description: "One-line description" }),
  icon: t.Optional(t.String({ description: "Relative path to the plugin's icon, served at /api/plugins/:id/icon" })),
  exposure: t.Union([t.Literal("private"), t.Literal("public-with-gate")], {
    description:
      "What publishing on this network exposes the server to: a network only invited machines are on, or the open internet with an identity check in front",
  }),
  platforms: t.Array(t.Union([t.Literal("darwin"), t.Literal("linux")]), {
    description: "Operating systems this plugin can be driven on at all",
  }),
  supported: t.Boolean({ description: "Whether THIS host's platform is in `platforms`. False rows are never probed" }),
  enabled: t.Boolean({ description: "Whether the instance offers this plugin (Settings → Plugins owns the flag)" }),
  interactiveLogin: t.Boolean({
    description: "True when joining with no credential can yield a URL a human finishes",
  }),
  publishImplicit: t.Boolean({
    description:
      "True when the network routes addresses to this machine by the fact of membership alone, so `published` is a record the host keeps rather than a state the daemon can be re-asked about (NetBird). The unpublish confirmation says which kind this is, because the two stop answering different things",
  }),
  install: t.Optional(
    t.Object(
      {
        command: t.String({ description: "The vendor's own install command" }),
        docsUrl: t.String({ description: "Installation documentation URL" }),
      },
      { description: "How to install the vendor CLI, when the plugin declares it" },
    ),
  ),
  privileged: t.Array(PrivilegedStepSchema, {
    description:
      "Steps the host can never perform, for THIS platform only, in the order to run them. Rendered to copy, never executed",
  }),
  labels: t.Object(
    {
      credential: t.Optional(
        t.String({
          description:
            'What this network calls the credential a person pastes: "Auth key", "Setup key", "Tunnel token". Absent means the UI picks a generic word',
        }),
      ),
      publish: t.Optional(
        t.String({
          description:
            'What this network calls publishing: "Publish with Tailscale Serve", "Start tunnel". Absent means the UI picks a generic word',
        }),
      ),
      credentialDocsUrl: t.Optional(
        t.String({
          description:
            "Where the vendor documents minting the credential, rendered as a Docs link beside the credential box. The manifest parser refuses anything but http(s)",
        }),
      ),
    },
    { description: "The vendor's own words for the two acts a person takes, from the manifest" },
  ),
  settingsFields: t.Array(NetworkSettingsFieldSchema, {
    description: "The plugin's settings editor schema; empty when it declares none",
  }),
  settings: t.Record(t.String(), NetworkSettingValueSchema, {
    description: "Stored settings, keyed by field. Secret fields report presence only",
  }),
  status: t.Optional(NetworkStatusSchema),
  process: t.Optional(SupervisorStateSchema),
  published: t.Boolean({
    description: "True when an admin published this server on this network and has not undone it",
  }),
});

/** `GET /api/network`. */
export const NetworkListResponseSchema = t.Object({
  networks: t.Array(NetworkRowSchema, { description: "Every installed, loadable network plugin, id-sorted" }),
});

/** The path parameter every act route takes. */
export const NetworkParamsSchema = t.Object({
  id: t.String({ description: "Network plugin id" }),
});

/**
 * What `unpublish` and `leave` answer with: which origins stopped accepting
 * sign-ins (as of this answer — the registry followed the record as the act
 * made it, so there is no config write and no restart to report), and the
 * fresh status.
 */
export const NetworkActionResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The act completed" }),
  origins: t.Array(t.String(), {
    description:
      "Origins the recorded publish had trusted and no longer does, as of this answer; empty when nothing had been recorded. Every kind subtracts, publishImplicit included",
  }),
  status: NetworkStatusSchema,
});

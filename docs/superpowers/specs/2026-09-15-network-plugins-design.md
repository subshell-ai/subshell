# Design: network plugins

**Date:** 2026-09-15
**Status:** approved

## 1. What this is about

Subshell is a trusted-network service (`docs/security.md` §0): reachable
remotely, but only across a perimeter the operator already owns. Today the
operator builds that perimeter by hand and then discovers, one 403 at a time,
that `TRUSTED_ORIGINS` and `APP_BASE_URL` also have to know about it. The
Add-node dialog still tells them to "replace the host with this machine's
VPN/LAN address", and nothing in the product knows what that address is.

The goal is one sentence: **an admin can connect the control plane to a
private network they already use, publish Subshell on it, and have the
resulting address flow into the config and the enroll command automatically** —
from the first-run wizard or from Server Settings, on a headless box as much as
on a laptop.

The mechanism is a **new plugin type**. Four integrations (Tailscale,
Headscale, NetBird, Cloudflare Tunnel) do not belong bolted into the server,
and a third party who uses a fifth network should be able to ship
`@subshell-ai/plugin-<id>` through the same registry and the same admin
install door as a harness. What the store already has — one install door,
admin-gated, instance-level, seeded built-ins, an enable flag — is exactly
what this needs, and duplicating it as "integrations" would give the operator
two concepts and us two of everything.

Four decisions taken with the operator on 2026-09-15, each of which the rest
of this document assumes:

| question | decision |
|---|---|
| Cloudflare Tunnel is PUBLIC exposure, and §0 says not to do that | **Require Cloudflare Access.** The plugin refuses to publish until an Access application covers the hostname, and the server verifies `Cf-Access-Jwt-Assertion` on traffic arriving at it. |
| plugins, or a separate "integrations" concept | **One store, `type: "network"`.** Reuse `@subshell-ai/plugin-api`, `/api/plugins`, the registry install and the seeding marker. The word stays "plugin". |
| long-lived credentials (the Cloudflare tunnel token) | **A 0600 file under the data dir**, host-owned, write-only from a plugin's view. `SUBSHELL_SECRETS_KEY` encryption (`docs/security.md` §8) stays deferred, now with one real customer. |
| platform compatibility | **Declared in the manifest as data**, rendered before any button. Every mesh daemon needs one `sudo` the server cannot run; the page prints that command rather than attempting it — the tmux-install rule (§11.10b), applied to a second family of installers. |

## 2. What exists today (measured, with file references)

### 2.1 The contract assumes exactly one shape of plugin

`packages/plugin-api/src/types.ts` (before this spec):

```ts
export type PluginType = "agent-harness" | "terminal";
export type PluginCapability = "mcp" | "resume" | "attention" | "settings";
export type PluginFactory = (host: PluginHost) => SubshellPlugin;
```

`capabilityMismatches(plugin: SubshellPlugin)` builds a **total**
`Record<PluginCapability, boolean>` of implemented members and walks
`PLUGIN_CAPABILITIES`, so every capability in the union is asked of every
plugin. There is one factory return type and one set of required members.

`PluginHost` is five members: `apiVersion`, `findBinary`, `detectBinary`,
`probeVersion`, `shellQuote`, `log`. Nothing a plugin is handed can execute
a command of its own choosing, store anything, or name the platform it is on.
`createPluginHost` (`packages/pane-runtime/src/plugin-host.ts:30`) builds
exactly those, and its own docstring says the rule: "A thin adapter over the
functions beside it, and it should stay one."

### 2.2 The loader requires three members, by name, for everything

`packages/pane-runtime/src/plugin-runtime.ts:230`:

```ts
const required = ["buildCommand", "validatePreset", "capabilities"] as const;
```

with the comment three lines above it: "Contract gate, not crash guard — do
not trim this list to current call sites." A network plugin has none of those
three, so the list has to become a lookup on `manifest.type` rather than a
constant. Line 214 holds the repo's one sanctioned `await import()`; line 219
constructs the host; line 250 runs the capability check.

### 2.3 The registry adapts every plugin into a harness

`packages/pane-runtime/src/registry.ts:45` lists six `BUILT_INS`, and both
paths that register a plugin pass it straight through `adaptPlugin`:

```ts
plugins.push(adaptPlugin(manifest, factory(createPluginHost({ pluginId: manifest.id }))));   // :77
plugins.set(loaded.manifest.id, adaptPlugin(loaded.manifest, loaded.plugin));                 // :207
```

`adaptPlugin` (`plugin-adapter.ts`) presents a plugin as the `HarnessPlugin`
the server and the agent consume — detection, version probing, argv. There is
no other registration path, so `allHarnesses()` is literally "every plugin".
Every consumer downstream (`getAllHarnessIds`, `detectSpecs`, preset
validation, the launch pickers) reads that list.

### 2.4 The type is already leaking into the UI as a two-member union

`apps/server/api/src/api/plugins.route.ts:65` and `api/models.ts:165` both
declare `t.Union([t.Literal("agent-harness"), t.Literal("terminal")])`, and
`toRow` (`plugins.route.ts:178`) ends with

```ts
    type:
      report?.type === "agent-harness" || report?.type === "terminal"
        ? …
        : (harness?.type ?? "agent-harness"),
```

— an unknown type is rendered as `agent-harness`. That fallback was harmless
when there were two types and both launched panes. With a third it would put
a VPN in the Agent picker, so it has to stop defaulting.

`packages/pane-runtime/src/plugins-dir.ts:177` has the same shape for a
broken plugin: `placeholderManifest` returns `type: "agent-harness"`.

### 2.5 There is already a bounded, allowlisted, admin-gated spawn core

`apps/server/api/src/services/agent-install.service.ts` holds it:

- `INSTALLER_ENV_KEYS` (`:62`) — `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
  `LANG`, `TERM` and the proxy pair, plus any `LC_*`. Explicitly **not**
  `process.env`: "the control-plane process holds `BETTER_AUTH_SECRET` and the
  database path, and a vendor's install script has no business reading either."
- `OUTPUT_CAP = 64 * 1024` (`:46`), drained past the cap rather than broken
  out of, so a full pipe cannot hang the child.
- `runInstaller(argv, { timeoutMs, extraPath, onLine })` (`:197`) — `stdin:
  "ignore"`, PATH = this process's PATH plus `loginPathEntries()`, a deadline
  that cancels the READERS rather than trusting `proc.kill()` (a pipeline's
  orphans hold the pipe open), and ANSI stripped at the source.

Two callers exist. `installBuiltInAgent` wraps a compiled-in `install.command`
in `sh -c`; the tmux route hands it a fixed argv. Both supply something fixed
by this repo rather than by a request — which is the property §11.10/§11.10b
lean on, and the one thing this spec changes (§9).

### 2.6 The streaming shell already exists, and so does its gate

`apps/server/api/src/api/setup-tmux-install.route.ts` is the model for every
long-running network act:

- The gate is one line (`:127`): `if ((await resolveSetupActor(request)) !==
  "admin") throw new ForbiddenError();`. `resolveSetupActor`
  (`api/setup.route.ts:82`) answers `"admin" | "cookie" | "machine"`, reading
  the role from `user_meta` — the same source `requireAdmin` reads.
- Refusals are decided **before the body opens** (`refuseTmuxInstall`, `:76`),
  because "once a stream starts the status line is already sent and 200 cannot
  be taken back".
- The sudo refusal (`:93`) is the load-bearing one, and its comment says why
  in the terms this spec inherits: "this is what keeps 'the server installs
  tmux' from meaning 'the server escalates'".
- The body is NDJSON — `{type:"line"}`* then one `{type:"done"}` or
  `{type:"error"}` — under `content-type: application/x-ndjson`,
  `cache-control: no-store, no-transform`, `x-accel-buffering: no`.

### 2.7 One writer owns the address surface

`applyConfig` (`apps/server/api/src/commands/configure.ts:394`) is THE
config.env writer, shared by `configure`/`init` and by
`PATCH /api/admin/server/config`, "so the CLI and the SPA cannot disagree
about what a valid file is". It validates each key with `validateValue`,
canonicalizes origins, computes advisory warnings (the LAN-bind/loopback trap
at `:447`, the port mismatch at `:458`, the empty-allowlist trap at `:466`),
and writes atomically, carrying foreign keys forward verbatim.

Downstream, `constants.ts:318` `localOriginsFor(port, host, baseUrl)` derives
the instance's own origins through `URL.origin`, and `TRUSTED_ORIGINS`
(`:389`) is that set unioned with the configured list.

And `apps/server/api/src/auth.ts:65-74` states the constraint that makes
`APP_BASE_URL` different in kind from `TRUSTED_ORIGINS`:

> rpID is deliberately unset — better-auth 1.7.1 derives it from the
> CONFIGURED baseURL (`options.rpID || new URL(baseURL).hostname` …), NEVER
> the request host.

So adding an origin is passkey-neutral and promoting one is not. That split is
already prescribed by `docs/security.md` §8; this spec is the first feature
that has to honour it in a UI.

### 2.8 What is therefore missing

Nothing about networks. No plugin type for one, no host member that can run a
command a plugin chose, no place to put a credential, no supervised child, no
request guard, no page. Every mechanism this needs is adjacent to one that
exists; that is the reason the change is mostly composition.

## 3. The rule: a network plugin describes, the host executes

**A network plugin returns argv, parses output, and names a secret. It never
spawns, never writes a file, never touches config.env, and never reads a
credential back.** Every effect goes through a `PluginHost` member the server
owns.

That is not a style preference. The existing installers are admin-gated,
bounded, env-allowlisted and audited because the server owns the spawn. Hand a
plugin the ability to spawn and every one of those properties becomes a claim
about code we did not write. Keeping the verbs on the host is what lets §9 say
"same gate, same executor" about a third-party plugin.

### 3.1 What the rule yields

| the plugin wants to | it does | the host does |
|---|---|---|
| ask the daemon a question | returns nothing; calls `host.run(argv)` | spawns under the allowlist, deadline, PATH and output cap; refuses relative argv and `sudo` |
| join a network with a pasted key | passes the key in argv, once | the same bounded run; nothing is stored |
| hold a long-lived credential | `host.secrets.set(name, value)` | writes 0600 under the data dir; never returns it |
| run a tunnel daemon | returns a `SupervisedProcessSpec` | spawns, backs off, restarts, reaps at shutdown, hydrates the secret at spawn |
| gate incoming traffic | returns a `RequestGuardSpec` | mounts ITS OWN middleware, verifies the JWT, keys on `Host` |
| make an address trusted | returns `NetworkAddress[]` | calls `applyConfig` — the one writer (§2.7) |
| need root | returns a `NetworkHint` with `privileged: true`, or declares `network.privileged` in the manifest | prints it. Never runs it. |

Two consequences worth stating as rules rather than leaving to be inferred:

- **A plugin holds no state.** `NetworkContext` carries the port, the stored
  settings, and which secrets are set, on every call. A plugin reloaded
  mid-life behaves identically to one running since boot, and a port that
  changed between two calls is simply the new port.
- **"Unsupported" is the host's word, never the plugin's.** Whether a plugin
  can run on this OS is manifest DATA (§4.2), so a page can say "not available
  on macOS" without importing a line of plugin code — and a plugin is never
  asked a question about itself whose answer it could get wrong.

## 4. The contract (`packages/plugin-api`)

`PLUGIN_API_VERSION` stays **2**. Every addition below is additive: new type
members, new host members, a new manifest block that is required only for a
type that did not exist. No existing plugin needs a rebuild.

### 4.1 Type and capabilities

```ts
export type PluginType = "agent-harness" | "terminal" | "network";
export const HARNESS_TYPES: readonly PluginType[] = ["agent-harness", "terminal"];
export function isHarnessType(type: PluginType): boolean;

export type PluginCapability =
  | "mcp" | "resume" | "attention"        // agent-harness / terminal
  | "publish" | "supervise" | "guard"     // network
  | "settings";                           // both

export const HARNESS_CAPABILITIES = ["mcp", "resume", "attention", "settings"];
export const NETWORK_CAPABILITIES = ["publish", "supervise", "guard", "settings"];
export function capabilitiesFor(type: PluginType): readonly PluginCapability[];
```

**One union, and the applicable SUBSET is per type.**
`capabilityMismatches(plugin, type)` takes the type, picks its `implemented`
table, and refuses in three directions rather than one:

- declared but not implemented (the existing check);
- implemented but not declared (the existing check, inverted);
- **declared but not applicable to this type** — `resume` on a network plugin,
  `publish` on a harness. Refused by name rather than ignored, because a
  silently dropped capability leaves whatever it implements unreachable with
  nothing said.

`publish` is checked as a **pair**: `publish` and `unpublish` must both be
present. A publish nothing can undo is not a capability, and the disable path
(§5.3) depends on being able to reverse one.

`settings` is shared and means a different member on each side —
`presetSettings()` on a harness, `settingsFields()` on a network plugin — which
is exactly why the table is chosen by type rather than merged.

`SettingsField.type` gains `"secret"`, plus `required` and `placeholder`.
`secret` is **write-only and network-only**: the route stores it through
`host.secrets`, a read reports `{ set: boolean }`, and the preset editor does
not render the type at all.

### 4.2 The manifest block

```ts
export type PluginPlatform = "darwin" | "linux";

export interface PrivilegedStep { label: string; command: string; docsUrl?: string }

export interface NetworkManifest {
  platforms: PluginPlatform[];                 // non-empty; a host refuses every act elsewhere
  interactiveLogin?: boolean;                  // join({}) may yield a login URL
  exposure: "private" | "public-with-gate";    // stated before publish, never defaulted
  privileged?: Partial<Record<PluginPlatform, PrivilegedStep[]>>;
}
```

`parseManifest` refuses **both** directions: `type: "network"` without a
`network` block, and a `network` block on a harness. A network plugin without
one would be unrenderable (nothing could say what publishing it exposes, and
"what does this expose" has no safe default); a harness with one declares
facts nothing reads, which is how a manifest starts lying.

It also refuses an `install.command` matching `/^\s*sudo(\s|$)/`, with the
message naming where privileged steps go instead. That is the field split that
matters: `install.command` is the one thing a HOST may run on request, so a
surface can offer a button for it without inspecting the string, and
`privileged` is the copy-only channel.

`detect` is reused unchanged — `binaryName` is `tailscale`, `netbird` or
`cloudflared`, and a network plugin's binary is probed by exactly the same
manifest-driven ladder a harness's is.

### 4.3 `NetworkPlugin`

```ts
export type NetworkState =
  | "not-installed" | "daemon-down" | "needs-privilege" | "needs-login" | "joined" | "published";

export interface NetworkAddress { url: string; scheme: "https" | "http"; label: string; secureContext: boolean }
export interface NetworkHint { text: string; command?: string; docsUrl?: string; privileged?: boolean }
export interface NetworkStatus {
  state: NetworkState;
  addresses: NetworkAddress[];
  loginUrl?: string; loginCode?: string;
  identity?: { network?: string; hostname?: string; version?: string };
  hints: NetworkHint[];
}

export interface NetworkContext {
  port: number;
  settings: Record<string, string>;
  secrets: { has(name: string): boolean };
}

export interface JoinInput { credential?: string; hostname?: string }
export type JoinOutcome = { state: "joined" } | { state: "needs-login"; loginUrl: string; loginCode?: string };

export interface PublishOutcome { addresses: NetworkAddress[]; process?: SupervisedProcessSpec; guard?: RequestGuardSpec }
export interface PublishRefusal { refused: NetworkHint }

export interface SupervisedProcessSpec {
  command: string; args: string[];
  env?: Record<string, string>;
  secretFileArgs?: Record<string, string>;   // "--token-file" → secret name
  secretEnv?: Record<string, string>;        // ENV_NAME → secret name
  readyPattern?: string;
}
export interface RequestGuardSpec { kind: "cloudflare-access"; hostname: string; teamDomain: string; aud: string }

export interface NetworkPlugin {
  capabilities(): PluginCapability[];
  status(ctx: NetworkContext): Promise<NetworkStatus>;
  join(input: JoinInput, ctx: NetworkContext): Promise<JoinOutcome>;
  leave(ctx: NetworkContext): Promise<void>;

  publish?(ctx): Promise<PublishOutcome | PublishRefusal>;   // `publish`
  unpublish?(ctx): Promise<void>;                            // `publish`
  supervisedProcess?(ctx): SupervisedProcessSpec | null;     // `supervise`, re-asked at boot
  requestGuard?(ctx): RequestGuardSpec | null;               // `guard`, re-asked at boot
  settingsFields?(): SettingsField[];                        // `settings`
  validateSettings?(values): PresetValidationIssue[];
}

export type PluginFactory = (host: PluginHost) => SubshellPlugin | NetworkPlugin;
```

Four members are required: `capabilities`, `status`, `join`, `leave`.

`status` is the plugin's **only** reporting surface: the host renders what it
returns and infers nothing. It is called on every page load and before every
act, so it must be cheap and must never throw — an unreachable daemon is
`daemon-down` with a hint, not a rejection.

`NetworkState` is a **ladder, not a set**: each state is reachable only from
the one before, which is what lets one card render the next action without
knowing which network it is looking at.

`secureContext` is a field rather than something inferred from the scheme at
each use site, and it is not a claim about encryption. A WireGuard mesh
encrypts an `http://` origin end to end; what `false` says is what the
**browser** will refuse there — passkeys, `Secure` cookies, service workers.
A person needs that before they try to sign in, not after.

A `PublishRefusal` is an **answer**, not a failure: it carries a hint to
render and never throws, because "enable HTTPS in the Tailscale admin console"
is a thing to do rather than an error to log.

`supervisedProcess` and `requestGuard` are re-asked at every boot rather than
remembered from the publish, so a rotated token or a changed port takes effect
on the next spawn without anyone re-publishing.

### 4.4 `PluginHost` additions, and why `secrets` has no `get`

```ts
run(argv: string[], opts?: RunOptions): Promise<RunResult>;
secrets: { set(name, value): Promise<void>; has(name): Promise<boolean>; delete(name): Promise<void> };
readonly platform: PluginPlatform;
readonly homeDir: string;
```

`RunOptions` is `{ timeoutMs?, onLine?, signal?, env?, stdin? }`;
`RunResult` is `{ code, stdout, stderr, timedOut, aborted }` and never throws
for a non-zero exit — a non-zero exit is an answer.

Rules `host.run` enforces, two of them by throwing:

- **`argv[0]` must be an ABSOLUTE path** (resolve it with `findBinary`). A bare
  name would resolve against a PATH the plugin cannot see, and the whole point
  of the lookup ladder is that the host owns it.
- **`argv[0]` whose basename is `sudo`, `doas` or `pkexec` throws before
  spawning.** Same sentence as §11.10b: the server has no terminal to answer a
  password prompt, so a privileged command is a copy-paste instruction and
  never something this runs. Three names rather than one, because the refusal
  is about privilege rather than about a spelling.
- env = `INSTALLER_ENV_KEYS` (§2.5) plus `opts.env`, plus the login-shell PATH.
  `opts.env` never overrides PATH.
- `stdin` is `/dev/null` unless text is given, so a prompt cannot hang forever.
- 64 KiB cap per stream; default deadline 30 s, hard cap 10 minutes.

`signal` exists for exactly one shape, and it is worth naming because it looks
odd otherwise: an interactive login. `tailscale up` with no key PRINTS the
authentication URL and then blocks until a human finishes in a browser. The
plugin reads the URL off `onLine` and aborts the run; the daemon stays in
`NeedsLogin` with `AuthURL` set, so the next `status` finds it. An aborted run
reports `aborted: true` and whatever was captured.

**`host.secrets` has no `get`, and that is the design rather than an
oversight.** A plugin that can read a credential can put it in argv (visible
in `ps`), in a log line, or in a hint string that renders in a browser. Every
legitimate consumer is a process the HOST spawns, so the host hydrates the
value itself from the name the plugin gave it: `secretFileArgs` writes it to a
0600 file and appends `<flag> <path>`, `secretEnv` puts it in the child's
environment. The credential therefore exists in neither the plugin's memory
nor any command line the plugin wrote. Values live at
`<dataDir>/plugins-state/<pluginId>/secrets/<name>`, 0600 inside 0700
directories, one file per secret. A host built without a data directory — the
node agent builds hosts too, and holds no network plugins — gets a store that
REFUSES `set` and `delete` by name and answers `has` with false, rather than
inventing a path to write to.

**Mesh keys never touch `secrets` at all.** A Tailscale auth key or a NetBird
setup key is consumed by the join and the daemon owns the identity afterwards,
so `join` passes it once in argv — the same single-transit exposure
`subshell enroll --key <nsk_…>` already accepts (`docs/security.md` §8b) — and
Subshell stores nothing. The only thing that goes into `secrets` is the
Cloudflare tunnel token, because there the token IS the identity and must
survive restarts.

`platform` and `homeDir` are read-only facts a plugin would otherwise get by
reading `process`, which it should not have to reason about.

### 4.5 Vendor mapping

|  | tailscale | headscale | netbird | cloudflare-tunnel |
|---|---|---|---|---|
| `platforms` | darwin, linux | darwin, linux | darwin, linux | darwin, linux |
| `exposure` | private | private | private | **public-with-gate** |
| `interactiveLogin` | true | true (finished by a Headscale admin) | true (device flow, falls back to a setup key) | false |
| `install.command` | none | none | none | darwin: `brew install cloudflared` |
| `privileged` (printed, never run) | linux: the install script, then `sudo tailscale set --operator=$USER`; darwin: `brew install --formula tailscale && sudo tailscaled install-system-daemon`, then the same operator line | same | linux: the install script (nothing further); darwin: `brew install netbirdio/tap/netbird && sudo netbird service install && sudo netbird service start` | linux: the apt repo / `.deb` step |
| `status` | `tailscale status --json` → `BackendState`, `Self.DNSName`, `TailscaleIPs`, `CertDomains`, `AuthURL`; "Access denied" ⇒ `needs-privilege`; socket error ⇒ `daemon-down`; `tailscale serve status --json` decides `published` | same, and `CertDomains` is always empty ⇒ http addresses with a hint saying why | `netbird status --json` → `management.connected`, `fqdn`, `netbirdIp`; the daemon hint text ⇒ `daemon-down` | binary present; `published` ⇔ the supervisor reports running (the host merges that in) |
| `join` with a credential | `tailscale up --auth-key=<cred> [--hostname …]` | `tailscale up --login-server <settings.controlUrl> [--auth-key …]` | `netbird up --setup-key <cred> [--management-url <settings.managementUrl>]` | validate the token's shape (base64 JSON carrying `a`, `t`, `s`), `host.secrets.set("tunnel-token", cred)`, return `joined` |
| `join` interactive | `tailscale up`, capture `To authenticate, visit:` off `onLine`, then abort | same; the hint names `headscale nodes register` | `netbird up --no-browser`, capture the URL and code, then abort | not offered |
| `publish` | `tailscale serve reset`, then `tailscale serve --bg --https=443 http://127.0.0.1:<port>` | `tailscale serve --bg --http=80 http://127.0.0.1:<port>` (**measure**, §10.3) | no-op: the addresses are `http://<fqdn>:<port>` and `http://<netbirdIp>:<port>` | Access pre-flight (§6), then a `process` for `cloudflared tunnel run` and a `guard` |
| `publish` refusal | `CertDomains` empty ⇒ refused, naming MagicDNS + HTTPS certificates | — | — | settings incomplete, or the pre-flight fails |
| `unpublish` | `tailscale serve reset` | same | no-op | the host stops the process, then drops the guard |
| `leave` | `tailscale logout` | same | `netbird down` | delete the secret |
| `settingsFields` | none | `controlUrl` (required) | `managementUrl` (optional) | `hostname`, `teamDomain`, `aud` (all required), `tunnelToken` (`secret`) |

Headscale is a **separate plugin with a separate id** that inlines the shared
source from the Tailscale package at build time (tsdown `noExternal`). It
drives the same `tailscale` binary against a different control server, and the
differences that matter — no HTTPS serve, an admin-finished login, a required
`controlUrl` — are exactly the things a user chooses between at install time.

## 5. Server

### 5.1 Routes: `apps/server/api/src/api/network/`

Its own module, deliberately not under `/api/plugins`. Those two answer
different questions: `/api/plugins` is "which plugins exist and are enabled" —
the store, memoised, GET open to any signed-in actor. These are "what is this
machine's network state" — live CLI probes, cookie-admin only, never public,
with streaming bodies.

Gate on every route: `resolveSetupActor(request) === "admin"`, else 403.
Reused from `setup.route.ts` (§2.6), and with **no no-users carve-out** — the
wizard's network step sits after Create Your Account for exactly this reason.
Dependencies are injected through `setNetworkDepsForTests`, the `IS_TEST`-
guarded seam every installer already uses.

| route | body | effect | streams |
|---|---|---|---|
| `GET /api/network` | — | one row per installed `network` plugin: `{ id, name, exposure, platforms, supported, enabled, status, settings, process?, hints }`. Live `status()` per enabled and supported plugin, memoised 3 s. Unsupported ⇒ `supported: false` and no probe. Secret fields report `{ set: boolean }`. | no |
| `PATCH /api/network/:id/settings` | `Record<string,string>` | `validateSettings` (400 with field problems) → `secret` fields to `host.secrets.set`, the rest to `network.json`. Audit `network.configure` with `{ fields: [names] }`, never values. | no |
| `POST /api/network/:id/join` | `JoinInput` | `join()`. Frames: `line`* then `done: { outcome, status }`. Audit `network.join` `{ mode: "credential" \| "interactive", ok }`. | yes |
| `POST /api/network/:id/publish` | `{ promoteBaseUrl?: boolean }` | `publish()` → arm the guard → arm the process → `applyConfig({ trustedOrigins: existing ∪ addresses })` → optionally `applyConfig({ baseUrl })` → `network.json.published = true`. `done: { addresses, config: { changed, warnings, written }, restartRequired: true }`. Audits `network.publish` `{ addresses, promotedBaseUrl }` plus the writer's own `server.config.update`. | yes |
| `POST /api/network/:id/unpublish` | — | the §5.3 sequence. `TRUSTED_ORIGINS` is left alone; the response says so. Audit `network.unpublish`. | no |
| `POST /api/network/:id/leave` | `{ confirm: string }` (the plugin id) | the §5.3 sequence, then `leave()`. Audit `network.leave`. | no |
| `PATCH /api/plugins/:id { enabled: false }` (existing) | — | for a network plugin: the §5.3 sequence BEFORE `setEnabled`; 409 if it fails. | no |

Every refusal is decided **before any body opens** — the tmux-route rule
(§2.6):

| condition | status | code |
|---|---|---|
| not installed, not `network`, or disabled | 404 | `NOT_FOUND` |
| `process.platform` ∉ `network.platforms` | 409 | `PLATFORM_UNSUPPORTED` (new) |
| another operation in flight on this plugin (a module `Set<string>`) | 409 | `EXISTS_ERROR` |
| join or publish while the state is `not-installed` / `daemon-down` / `needs-privilege` | 409 | `NETWORK_NOT_READY` (new; the message is the first hint) |
| a required settings field unset | 409 | `NETWORK_UNCONFIGURED` (new) |
| a `SupervisedProcessSpec` or a `run` argv would need sudo | 409 | `PRIVILEGE_REQUIRED` (new) |
| a Cloudflare publish whose Access pre-flight fails | 409 | `ACCESS_UNCONFIGURED` (new) |
| a malformed credential (the plugin's own shape check) | 400 | `INPUT_VALIDATION_ERROR` |
| `TRUSTED_ORIGINS` or `APP_BASE_URL` has `source === "process env"` | publish COMPLETES; `done.config.written: false` names the key | — |

That last row is the existing "a write the next read would mask is not a
success" rule (`.claude/rules/security-context.md`, the config ladder). The
publish itself is real — the server IS reachable at the address — so it is not
refused; what is reported is that the config could not follow.

Streaming reuses the tmux route's shell verbatim, and the SPA reads it with
the existing `readInstallStream`.

### 5.2 The supervisor: `services/network/supervisor.ts`

```ts
export interface SupervisorState {
  running: boolean; pid?: number; since?: string;
  restarts: number; lastExit?: { code: number | null; at: string }; lastLines: string[];
}
export function armProcess(pluginId: string, spec: SupervisedProcessSpec): void;   // idempotent; respawns on a changed spec
export async function disarmProcess(pluginId: string): Promise<void>;              // SIGTERM, 5 s, SIGKILL; resolves when reaped
export function processState(pluginId: string): SupervisorState | null;
export async function stopAllProcesses(): Promise<void>;
```

One child per plugin, `Bun.spawn` with the same allowlisted env `host.run`
uses; secrets are hydrated **here, at spawn, and nowhere else**. Backoff starts
at 1 s and doubles to 60 s, resetting after 5 minutes up. More than 10 restarts
in 10 minutes **parks** it: `running: false` plus a hint, and it is never
disarmed, so the operator sees a stopped tunnel rather than a silent one.

Not `cloudflared service install`: that wants root on Linux, and on macOS it
writes a per-login LaunchAgent holding the token in a plist. Supervising it
ourselves keeps the credential in one 0600 file the host owns and makes
"disable this plugin" a real stop.

### 5.3 Unpublish and disable, one function (`services/network/unpublish.ts`)

1. `disarmProcess(id)`, **awaited** — traffic can no longer arrive over the
   tunnel.
2. `plugin.unpublish(ctx)`.
3. Drop this plugin's guard from the active set.
4. `network.json.published = false`.

**Guard-off is last.** Any other order leaves an instant in which a tunnel is
alive and unguarded, which for a `public-with-gate` plugin is the whole
exposure this design refuses to take. A failure at step 1 leaves the guard ON
and answers 409 with the supervisor's last lines.

### 5.4 Config writes

Both go through `applyConfig` (§2.7). There is no second writer, and that is
what makes `docs/security.md` §8's validator claims true of this feature
without restating them.

The `TRUSTED_ORIGINS` union is the default and is **passkey-neutral**.
`promoteBaseUrl` is opt-in and carries `applyConfig`'s own warnings plus one
the route adds about the rpID move (§11). Neither takes effect until restart;
the `done` frame says so and the SPA offers the existing `RestartDialog`.

Removal is not here. Unpublishing does not strip an origin from
`TRUSTED_ORIGINS` — that is the Addresses card's act (§14), and the response
says where to do it.

### 5.5 Boot and shutdown

In `index.ts`, after `prepareLocalPlugins()` and **before** `startServer`:
`prepareNetwork()` installs `requestGuard()` for every enabled network plugin
whose `network.json.published` is true. That step is pure — no I/O, no spawn.

After `startServer` resolves: `armProcess` for each `supervisedProcess()`.

The ordering is the point. **Guard before the listener**, so the first request
arriving over a tunnel is already gated. **Process after the listener**, so
`cloudflared` never proxies to a port nothing answers on. Errors log and land
on the plugin's row; a network plugin never blocks boot.

`server-restart.ts`'s exit path and the signal handlers call
`stopAllProcesses()` first.

The desktop apps gain nothing from this feature. Every privileged step is a
copy-paste hint, which is all a native page could offer as the same user.

### 5.6 When the server port changes

A port change (`PATCH /api/admin/server/config { port }`, or `configure
--port`) takes effect at the next boot, so that is where the network half
follows it. `network.json` records the port each plugin was published on;
plugins never store an address and always compute one from `ctx.port`, so
`GET /api/network` is right immediately. At boot, `prepareNetwork()` compares
`SERVER_PORT` with each published plugin's recorded port and, when they
differ, reconciles after the listener is up:

- **Tailscale / Headscale:** re-run `publish(ctx)` — `serve reset` then `serve`
  against the new `127.0.0.1:<port>`. The `ts.net` origin carries no port, so
  `TRUSTED_ORIGINS` is unchanged.
- **NetBird, and Headscale's http fallback:** the origin carries the port, so
  the reconcile calls `applyConfig` to ADD the new origin (union, never
  removal), and the row says the old one can be dropped on the Addresses card.
  This write lands one boot late by construction, which is why the config
  route's response warns about it (§11).
- **Cloudflare:** the origin port lives in the tunnel's remote ingress, which
  the token cannot change. The reconcile cannot fix it. `status()` returns a
  hint naming the dashboard field, and the supervisor keeps running.

Each reconcile is audited as `network.publish` with `{ reason: "port-change",
from, to }`. A failure logs, sets the row's hint, and never blocks boot.

## 6. The Cloudflare Access guard

`apps/server/api/src/plugins/access-guard.plugin.ts`, mounted in `server.ts`
immediately after `errorHandlerPlugin` and **before** cors, the rate limiter,
`/install.sh`, auth, static and `wsPlugin`.

**Keyed on `Host`, never on `CF-Ray`.** A header-presence rule is trivially
evaded: a LAN client simply omits `CF-Ray`. A client cannot make a Host rule
skip without changing Host, and a request carrying `Host: <tunnel hostname>`
with no assertion is refused wherever it came from. Cloudflare's edge only
forwards Hosts inside the zone, so a visitor cannot pick a different Host to
evade it either. Belt: a matching Host arriving from a non-loopback
`remoteAddress` is refused regardless, since `cloudflared` always connects from
127.0.0.1.

The rule: normalise Host (lowercase, strip the port); if it equals an active
guard's `hostname`, read `Cf-Access-Jwt-Assertion` — falling back to the
`CF_Authorization` cookie, which is how a browser WebSocket upgrade carries it
— and `jwtVerify` with `jose`'s `createRemoteJWKSet` over
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (memoised per team;
it caches and rate-limits its own refetches), issuer
`https://<team>.cloudflareaccess.com`, audience `aud`.

Failure is `403 ACCESS_REQUIRED` **for every path, with no exemptions**.
Access covers the whole hostname, so a 403 here means Access is misconfigured,
and that is something the operator must see rather than something to route
around. The verified email is attached for audit metadata only. **It is never a
session**: Subshell's own cookie is still required behind it.

The **pre-flight** at publish time is the plugin's own `fetch`, with
`redirect: "manual"`, to `https://<hostname>/`. It requires either a 302 to
`https://<team>.cloudflareaccess.com/…` or a 403 carrying `cf-access-*`
headers. Access evaluates at the edge, before the origin, so this passes
before the tunnel is even up and fails on a bare public hostname — which is the
exact thing being guarded against.

Two things about this section are measurements, not assertions: whether
Elysia's `onRequest` runs on the `/ws` and `/ws/node` upgrade path under Bun
(§10.6), and the exact status and header names the pre-flight sees (§10.5).

## 7. SPA

### 7.1 Settings → Networking (`routes/settings_.networking.tsx`)

One `NavItem` in `app-sidebar.tsx`'s `server-settings` group, icon `Network`,
short label "Net". The page shape copies `settings_.service.tsx`:
`viewerIsAdmin === undefined ? null : isAdmin ? cards : the admins-only line`.
`useNetwork(isAdmin)` polls `GET /api/network` every 5 s while a join is
pending (an interactive login resolves out of band, so the page has to watch
for it) and every 30 s otherwise.

One `NetworkPluginCard` per installed network plugin, rendering by state:

- **`supported: false`** — the unavailable line, no controls.
- **`not-installed`** — this platform's `privileged` steps as `CopyCommandRow`s,
  plus an **Install** button only when `install.command` exists for this
  platform (Cloudflare on macOS), streaming like the tmux row.
- **`daemon-down` / `needs-privilege`** — the plugin's hints verbatim, with
  **Re-check**.
- **`needs-login`** — a credential field and **Connect**; when
  `interactiveLogin`, also **Sign in instead**, which runs `join({})` and
  renders the returned URL (and code) as a `CopyableValue` while polling.
- **`joined`** — the addresses, each with its `secureContext` sentence;
  **Publish** (labelled per plugin); a **Set as base URL** checkbox carrying
  the rpID sentence; **Disconnect**.
- **`published`** — the addresses as `CopyableValue`s, the supervisor state
  line when there is a process, the config outcome with the `RestartStrip`,
  and **Unpublish**.
- **`exposure: "public-with-gate"`** — a permanent amber note above the card
  body, and the settings fields; **Publish stays disabled until the settings
  are complete.**

A second card, "Add a network", lists built-in network plugins from the
catalog that are not installed, reusing `plugin-catalog-card.tsx` filtered by
type. Settings → Plugins groups rows by type under a "Network" heading, and
the Enabled switch on a network row confirms before `PATCH` (§11).

### 7.2 The wizard step (`routes/setup.tsx`)

`STEPS = ["Account", "Network", "Agent", "Launch"]`. The dot count follows
`STEPS.length` automatically.

The step is **optional and skippable**, and sits right after Account because
these routes need an admin session. It reuses `NetworkPluginCard` in a compact
`NetworkStep` list: plugins whose CLI is already detected on this host first,
the rest collapsed under "Other networks" with their install hints. Detection
polls every 4 s while the step is shown, like the Agent step.

The second entrance is Settings → Networking, and `setup-checklist-card.tsx`
gains a "Connect a network" item when `HOST=0.0.0.0` and no non-loopback
origin is configured — the existing `lan-origin` item's remedy becomes a link
there.

### 7.3 What must not change

Every launch picker filters `type === "agent-harness"` rather than excluding
`terminal`. Today `lib/subshell-compat.tsx:111` and mobile
`lib/agent-default.ts:40` both test `t !== "terminal"`, which would silently
adopt a network plugin as a default agent. The full list to change:
`subshell-compat.tsx`, `routes/setup.tsx`'s Agent step,
`setup-checklist-card.tsx`, `node-harness-card.tsx`, and the mobile
`agent-default.ts`.

Server side the same property is structural: `getAllHarnessIds()`,
`usableHarnessIdSet`, `detectSpecs()` and `detectEnvNames()` all read
`allHarnesses()`, which now filters by type — so a network plugin never ships
to a node, never appears in a preset, and is never probed for on a remote
machine.

`e2e/tests/15-onboarding-clean-machine.spec.ts` asserts the Agent list is
harness-only, and gains a skip through the network step.

## 8. Platform compatibility, stated per vendor

This section is the reason `platforms` and `privileged` are manifest DATA. The
rule underneath all of it: **every mesh daemon needs one `sudo` the server
cannot run**, and the server has no terminal to answer a password prompt
(§11.10b). What the UI offers therefore differs per vendor and per platform,
and it has to differ from manifest data alone — before the vendor's CLI is
anywhere on the machine.

**Tailscale.** The daemon install is root, once, on both platforms. After it,
the CLI still refuses an unprivileged user until `sudo tailscale set
--operator=<user>` has been run — required on Linux, and on the Homebrew
`tailscaled` formula on macOS. So `needs-privilege` is a real, reachable state
with a copyable command, and the plugin maps the CLI's "Access denied" onto it
rather than reporting a generic failure. **The macOS App Store and standalone
variants are a different product for our purposes**: their CLI talks to a
logged-in desktop session, and `tailscale up` there opens the user's browser
instead of printing an authentication URL. A launchd-run server has neither a
session nor a browser, so the interactive join cannot work and `status --json`
may not answer at all. The macOS hints therefore name the `tailscaled` formula
explicitly, and §10.7 is the measurement that says what the page must render
when it finds the other variant.

**Headscale.** Identical client, identical privileged steps, identical
operator requirement — it is the same `tailscale` binary pointed at a
different control server. What differs is the outcome: HTTPS serve fails
(headscale#2527), so the addresses are `http://` and `secureContext` is false
on both platforms.

**NetBird.** The install is privileged on both platforms (`sudo netbird
service install` on macOS after the brew tap; the install script or apt on
Linux), but **from ≥ 0.76 the CLI authorises callers by kernel peer
credentials**, so once the daemon is installed the server's own unprivileged
user may run `up` and `status --json` without further grants. NetBird therefore
has no `needs-privilege` state in practice: the ladder goes straight from
`not-installed` to `daemon-down` to `needs-login`. On macOS peers, name
resolution for other peers needs a nameserver group configured in the NetBird
console, which is why `publish` emits a hint alongside the `fqdn` address
rather than presenting it as certain to resolve.

**Cloudflare Tunnel.** `cloudflared` needs **no root anywhere**. That is the
whole reason it is the one plugin carrying an `install.command` the server may
run itself (`brew install cloudflared` on macOS); the Linux apt-repo step is
still `privileged` and printed. It is also why the tunnel runs as a supervised
child of the server rather than as an installed service (§5.2) — nothing here
requires the privilege that `cloudflared service install` would.

Consequences for what the UI offers, stated once:

| | install button | `needs-privilege` state | interactive login |
|---|---|---|---|
| Tailscale (linux, brew `tailscaled`) | no | yes | yes |
| Tailscale (macOS GUI variants) | no | yes | **no** — see §10.7 |
| Headscale | no | yes | yes, finished by an admin |
| NetBird | no | no | yes (device flow), else a setup key |
| Cloudflare Tunnel | macOS only | no | n/a |

## 9. Security accounting (→ `docs/security.md` §11.13)

The headline claims, each measured against an existing section rather than
asserted fresh:

- **Same gate and the same bounded executor as §11.10 / §11.10b**, with one
  real difference: **the argv comes from plugin code rather than from a
  compiled-in table.** That is not a new trust decision, it is the one already
  accounted in §11.9 — a plugin runs in the control-plane process with no
  sandbox, so its `run` calls are exactly as trusted as its install was. Cookie
  admin only, bearer refused, never public; `sudo` refused before anything
  runs.
- **New: plugins may make outbound requests.** §11.9 already grants the
  network; the Access pre-flight is the first built-in that uses it.
- **A new credential class at rest**: the Cloudflare tunnel token. 0600 under
  the data dir, write-only to plugins, hydrated only into a host-spawned child.
  **`subshell-server backup` does NOT cover it** — that verb snapshots the
  database and nothing else (`services/db-backup.ts` `VACUUM INTO` over
  `DATABASE_PATH`; `commands/backup.ts` calls `backupDatabase` alone). A
  restored instance must have its tunnel token re-entered, and the UI says so
  rather than letting it be discovered.
- **Mesh keys transit argv once** and are `ps`-visible for the life of one
  short command: the accepted `enroll --key` class.
- **The server still trusts no proxy header.** `X-Forwarded-*`,
  `Tailscale-User-Login` and `Cf-Access-Authenticated-User-Email` are all
  ignored. Only the signed assertion is verified, and only as a front door.
- **Login backoff stays per-email.** Under a tunnel every request appears to
  come from 127.0.0.1, which costs nothing today — but it is the reason a
  per-IP limit added later must read `CF-Connecting-IP`, and only behind the
  guard.
- **Cloudflare inverts §0, and every part of the design says so**: the
  exposure is manifest data rendered before the button, publish is refused
  without Access, the guard fails closed on Host, and disable stops the process
  before it drops the guard.
- **Tailscale Serve puts the machine name in public CT logs.** Stated on the
  publish button rather than discovered afterwards.
- **The address surface widens through `applyConfig`** — §11.11's writer,
  unchanged. `TRUSTED_ORIGINS` is additive and passkey-neutral; `APP_BASE_URL`
  moves the passkey rpID and is opt-in with the warning. Audit rows name
  origins and field names, never values.

§12's hardening checklist gains one line: a `public-with-gate` plugin makes the
guard the perimeter.

## 10. Measurements the implementer must make and record

Each of these is an assumption this design rests on. Record the result **in
this document** (an amendments section, as spec 2026-09-15 §15 does) rather
than only in a commit message.

1. **`tailscale up` with no key** prints `To authenticate, visit:` — on stdout
   or stderr? — and aborting the process leaves `BackendState: NeedsLogin`
   with `AuthURL` set. Expected yes; the interactive join depends on it.
2. **`tailscale serve` as a non-root operator** on 1.98.10+, with an HTTP
   target only. Bulletin TS-2026-005 introduced a regression here
   (tailscale#21204); confirm on the installed version or pin a floor.
3. **`tailscale serve --bg --http=80` against a current Headscale.** If it is
   refused, the Headscale plugin publishes the bare
   `http://<host>.<base_domain>:<port>` address with no serve at all, and the
   vendor table's `publish` row changes accordingly.
4. **NetBird ≥ 0.76**: `netbird up --setup-key` and `netbird status --json` as
   a non-root user, on Linux and on macOS (brew tap plus LaunchDaemon). This is
   what the "no `needs-privilege` state" claim in §8 rests on.
5. **`cloudflared --token-file`**: the version floor (believed 2025.4.0), and
   the Access pre-flight response — 302 or 403, and the exact header names.
6. **Elysia `onRequest` on Bun WebSocket upgrades** (§6). If it does not run
   there, the fallback is a shared `requireAccess(request)` called first in
   both upgrade hooks AND in `onRequest`; the guard is not correct without one
   of the two.
7. **macOS Tailscale variants**: which CLI path each installs, and whether the
   GUI-variant CLI answers `status --json` from a launchd-run process. The
   answer decides what §8's table's second row renders.

### 10a. Results, as of the phase 1 cut (2026-09-15)

Recorded here so that "measured and true" is distinguishable from "assumed".
Anything still open is named as open rather than quietly treated as settled.

| # | status | result |
|---|---|---|
| 1 | **open** | No live tailnet was available. The interactive join reads the URL off the output AND falls back to re-reading `AuthURL` from `status --json`, so it does not rest on which stream carries it. The fallback at `join.ts` exists precisely because this is unmeasured. |
| 2 | **open** | No version floor is pinned anywhere in the plugin. If TS-2026-005's regression is present on an operator's install, `publish` fails and the refusal carries the CLI's own stderr — a bad message rather than a wrong state, but still unmeasured. |
| 3 | deferred | Phase 2 (Headscale). |
| 4 | deferred | Phase 2 (NetBird). |
| 5 | deferred | Phase 3 (Cloudflare Tunnel). |
| 6 | **measured** | Elysia 1.4.29 on Bun 1.4.2 DOES run `onRequest` for the WebSocket upgrade, and a `Response` returned from it prevents the upgrade: the socket's `open` hook never fires. So no `requireAccess` was threaded into the two upgrade hooks. Pinned by three tests in `access-guard.plugin.test.ts` against a REAL listener, which will say so if a version bump changes the answer. |
| 7 | **partially settled, by avoidance** | Still unmeasured. The plugin no longer names the macOS app bundle in `knownPaths`, so it does not actively resolve the GUI variant a launchd-run server cannot drive; the Homebrew `tailscaled` formula is found on PATH. A machine with only the GUI variant installed therefore reports `not-installed` and renders the install hints, which is honest but is not the distinct state §8's table anticipates. |

Two further things were measured while building, neither of them in the list
above, and both changed code:

- **A trapped SIGTERM outlived `runBounded`'s deadline.** A child running
  `trap '' TERM; sleep 20` against a 500 ms deadline had its reads cancelled at
  501 ms and the CALL return at 20010 ms, because `proc.kill()` sends only
  SIGTERM and the call then awaits the real exit. SIGTERM is now followed by
  SIGKILL after a grace.
- **Two Host headers reach a Bun 1.4.2 handler joined as `a, b`**, and a
  trailing dot survives verbatim. Both spellings named a guarded host while
  matching no guard, so `normalizeHost` strips the root label and a value
  naming a guarded host anywhere is refused rather than admitted by the
  ambiguity.

### 10b. Deviations from this spec, as built

Recorded rather than quietly fixed, because each is a decision and a later
reader should find the decision rather than the discrepancy.

- **`PRIVILEGE_REQUIRED` and `ACCESS_UNCONFIGURED` are not 409 codes.** §5.1's
  refusal table named them, and neither turned out to have a route that could
  raise one. A `sudo` or relative-path command is refused by `PluginHost.run`
  and by the supervisor at spawn, so it surfaces on the plugin's own row rather
  than as a status on a request; an Access pre-flight failure is the plugin
  declining to publish, which arrives as a `done` frame with `ok: false` and a
  hint. Both are refusals in the right place; only the transport differs from
  what the table predicted.
- **§6's `ACCESS_REQUIRED` is `ACCESS_DENIED` in the code**, which is the
  existing member of the error enum. A new code naming the same condition would
  have been a second spelling of one thing.
- **Guard removal is keyed by the OWNING PLUGIN, not by the guard's value.**
  §5.3 described removing the specs the plugin declares now. That is not a way
  to FIND the installed one: a settings write while published changes the
  hostname or audience the plugin describes, so the guard standing in front of
  live traffic stopped matching and nothing short of a restart could remove it.
  The ownership tag is the host's own record of which plugin it resolved the
  guard from, never a field a plugin fills in — so the property §5.3 was
  protecting (a plugin cannot name another plugin's guard) is unchanged.
- **`jose` already closes algorithm confusion.** Measured on 6.2.9 against a
  real `createRemoteJWKSet`: a token with `alg: HS256` or `alg: none` is
  refused before a key is produced, whether or not it carries a `kid`, and
  whether the claimed secret is the modulus or the JWK as JSON. The guard pins
  `algorithms: ["RS256"]` anyway, so that guarantee is a property of this
  repository rather than of a dependency's current behaviour.

## 11. Copy, exact

Every user-visible string in the feature. Implementers use these verbatim.

**Page.** Title: *Networking*. Subtitle: *Connect this server to a private
network so your other devices can reach it.* Non-admin line: *Networking is
available to admins.*

**Wizard step.** Title: *Network*. Subtitle: *Reach this server from your
other devices over a network you already use.* Skip control: *Skip for now*.
Collapsed group: *Other networks*.

**Checklist item.** Title: *Connect a network*. Body: *This server listens on
every interface, but no address outside loopback is trusted yet. Connect a
network, or add the address on Settings → Service.*

**Card states.**

- unsupported: *Not available on macOS.* / *Not available on Linux.* Hint:
  *<Name> can be driven on <platforms> only.*
- not-installed: *<Name> is not installed on this host.* Above the steps:
  *These steps need root, so run them yourself and re-check — the server has no
  terminal to answer a password prompt.*
- daemon-down: *<Name> is installed, but its daemon is not running.*
- needs-privilege: *<Name>'s daemon is running, but this server's user may not
  drive it.*
- needs-login: *This machine is not on <network> yet.* Field labels: *Auth key*
  (Tailscale, Headscale), *Setup key* (NetBird), *Tunnel token* (Cloudflare).
  Buttons: **Connect**, **Sign in instead**. Interactive: *Open this URL to
  finish signing in. This page updates when you are done.*
- joined: *This machine is on <network>.* Publish buttons, per plugin:
  **Publish with Tailscale Serve**, **Start tunnel**, **Use this address**.
- published: *Subshell is published on <network>.*

**Secure context**, under each address, verbatim:

- *Passkeys and secure cookies work at this address.*
- *Encrypted by the network, but your browser sees plain http: passkeys and
  secure cookies will not work here.*

**Base URL promotion.** Checkbox: *Also make this the server's base URL.*
Warning beneath it: *APP_BASE_URL moves the passkey rpID to <host>. Passkeys
registered on <old host> stop working there, including the Subshell Server
app's own window. Adding this address to trusted origins does not have that
effect, and is enough to sign in from it.*

**After publishing.** *Added to trusted origins. Restart the server to apply.*
When the config could not be written: *TRUSTED_ORIGINS is set in this server's
environment, so config.env was not written. Add <origin> to the environment
yourself.*

**Tailscale CT note**, on the publish button's detail line: *Tailscale Serve
gets a public certificate for <host>.<tailnet>.ts.net. That name appears in
public Certificate Transparency logs, so this machine's name becomes public —
the server itself stays private to your tailnet.*

**Cloudflare exposure note**, permanent, amber, above the card body:
*Cloudflare Tunnel reaches the public internet. Subshell is built for a
trusted network, so this plugin will not publish until a Cloudflare Access
application covers this hostname, and every request arriving through the
tunnel must carry a valid Access assertion. Access is the perimeter: if it
stops covering the hostname, this server is exposed.*

**Cloudflare secret note**, beside the tunnel-token field: *Stored on this host
in a file only the server can read. `subshell-server backup` does not include
it — after a restore, paste it again.*

**Confirmations.**

- Unpublish: *Stop publishing on <Network>? This machine stays on the network;
  Subshell stops answering at <url>. The trusted-origin entry is left in place
  — remove it on Settings → Service if you want it gone.* Button: **Unpublish**.
- Disconnect: *Disconnect from <Network>? Subshell stops being published there
  and this machine leaves the network. Any device that reaches this server only
  at that address will lose it. Running subshells are not affected.* Confirm by
  typing the network's id. Button: **Disconnect**.
- Disabling from Settings → Plugins: *Disabling <Name> unpublishes this server
  and stops anything it is running. The machine stays on the network.* Button:
  **Disable**.

**Refusals**, by code:

- `NOT_FOUND`: *No network plugin with that id is installed and enabled.*
- `PLATFORM_UNSUPPORTED`: *<Name> cannot be driven on <this platform>. It
  supports: <platforms>.*
- `EXISTS_ERROR`: *Another <Name> operation is already running on this host.*
- `NETWORK_NOT_READY`: the first hint's `text`, verbatim.
- `NETWORK_UNCONFIGURED`: *<Name> needs these settings first: <fields>.*
- `PRIVILEGE_REQUIRED`: *That step needs root, and the server has no terminal
  to answer a password prompt. Run the command yourself and re-check.*
- `ACCESS_UNCONFIGURED`: *Cloudflare Access does not cover <hostname> yet.
  Create an Access application for it, then publish.*
- `INPUT_VALIDATION_ERROR`: the plugin's own sentence.

**Publish refusals**, from the plugins:

- Tailscale: *Enable HTTPS certificates and MagicDNS in the Tailscale admin
  console, then re-check — Serve needs both before it can answer on https.*
- Headscale, as a hint rather than a refusal: *Headscale does not issue
  certificates, so this address is plain http over WireGuard.*
- Cloudflare, settings incomplete: *Set the hostname, team domain and
  application AUD before publishing.*

**Config route warning**, added when a port change lands on a published
network: *Published networks re-point at the new port on restart; http origins
need one more restart.*

## 12. Phases

Each ships independently. What each one leaves undone is named, so a partial
landing is a state rather than a gap.

1. **Framework and Tailscale.** The contract, the loader split, the shared
   bounded-run core, `host.run` / `host.secrets`, `network.json`, the whole
   `/api/network` surface, the Networking page, the wizard step, the `type`
   audit across SPA / mobile / server, `@subshell-ai/plugin-tailscale`,
   `docs/security.md` §11.13 and the AGENTS.md updates. **Without the later
   phases:** one network, HTTPS, and the entire UX.
2. **Headscale and NetBird.** Two thin plugins over the same surface, the
   `secureContext: false` copy, and NetBird's device-flow login. **No server
   change** beyond registering two more built-ins.
3. **Cloudflare Tunnel.** The supervisor, the Access guard, the `secret`
   settings field, `@subshell-ai/plugin-cloudflare-tunnel`, the boot and
   shutdown arming, the disable-ordering function, and §12's checklist line.
   **Without it:** neither `supervise` nor `guard` is exercised by any shipped
   plugin, and both stay in the contract as declared-but-unused — which
   `packages/plugin-api/README.md` must say out loud, or a third party reads
   two members as proven.

Changesets: `@internal/server` (the SPA and the API) and
`@subshell-ai/plugin-api` (minor). Each new `@subshell-ai/plugin-*` must be
**bootstrapped on npm at 0.0.1 by hand** before its first version PR — a
trusted publisher cannot be configured for a package that does not exist, and
AGENTS.md's "an EIGHTH package would need the same bootstrap" is this case,
four times over. No changeset for `@internal/server-web` or pane-runtime; both
are `ignore`d workspaces, and a changeset naming one wedges the version PR.

## 13. Testing

- **plugin-api**: `capabilityMismatches` per type, including the
  cross-type refusal; the manifest parser refusing `type: network` without a
  `network` block, refusing a `network` block on a harness, refusing a
  `sudo`-prefixed `install.command`, and accepting `privileged`.
- **pane-runtime**: loader fixtures `network-good`, `network-missing-join`,
  `network-claims-publish-without-member`; the bounded-run core refusing
  relative and `sudo` argv, allowlisting env, capping output, honouring the
  abort signal; the registry type split; the seeding marker union seeding four
  new ids without disturbing `PRE_RECORD_BUILT_INS`.
- **plugins**: each against `createTestHost` with scripted `run` answers, using
  real `status --json` fixtures captured during §10. Tailscale refuses publish
  on empty `CertDomains`; Cloudflare refuses without settings and rejects a
  malformed token; Headscale shares the Tailscale tests by import.
- **server routes**: the gate matrix (anonymous 401, non-admin 403,
  bearer-admin 403, cookie-admin 200 or stream), every refusal row in §5.1,
  NDJSON frame order, `applyConfig` called with the union and with canonical
  origins, a `process env` source producing `written: false`, the audit
  metadata scanned for the credential (the `admin-status` no-secret test
  pattern), and disable running the unpublish sequence first.
- **port reconcile**: boot with `network.json.port ≠ SERVER_PORT` re-publishes
  Tailscale, unions the new NetBird origin, hints on Cloudflare, audits
  `reason: "port-change"`, and never throws out of boot.
- **supervisor**: a fake spawn — backoff, parking after a crash loop, secrets
  hydrated into a temp path and never into argv text, `stopAllProcesses` reaps.
- **guard**: Host match with a valid JWT passes; missing, expired and
  wrong-`aud` all 403; a non-matching Host is untouched; a matching Host from a
  non-loopback address is refused; the cookie fallback works on an upgrade; the
  guard-set swap is atomic.
- **SPA**: the Networking page's state matrix (Testing Library), the wizard
  step's skip and dot count, `subshell-compat`'s default excluding the network
  type, the sidebar entry being admin-gated; and the mobile `agent-default`
  test.
- **e2e**: the onboarding spec gains a network-step skip. A fixture network
  plugin is out of scope (fixtures are not built-ins), so the e2e asserts the
  Networking page renders the built-ins as `not-installed` with their platform
  hints.
- **Verification**: `bun run verify-types && bun run lint:check && bun run
  test`, then `bunx turbo build` (packages changed — the mobile Metro barrel
  trap), `bun run lint:licenses` (four new Apache packages), `bun run
  lint:design` (new UI), and `bun run test:e2e` for the onboarding spec.
  Manually, on a Mac with the brew `tailscaled` formula: drive the Networking
  page end to end and confirm a phone on the tailnet signs in at the `ts.net`
  address after a restart. Record §10 here.

## 14. Non-goals, named

- **Joining NODES to a network.** Nodes dial outbound. A node on the same mesh
  benefits when the operator promotes the base URL or repoints it with
  `subshell configure --server`, and the publish response says so.
- **Installing any root-level daemon from the server.** Printed, never run.
  This is §11.10b's rule applied to a second family of installers, and it is
  the boundary the whole feature is shaped around.
- **Vendor management APIs** — minting Tailscale auth keys over OAuth, NetBird
  setup keys via a PAT, creating Cloudflare tunnels and Access applications
  with an API token. All of it is real and documented in §4.5's research; it is
  a phase 4 if pasting a key proves too much to ask.
- **Tailscale Funnel, NetBird's `expose` / reverse proxy, and
  `trycloudflare.com`.** Each is public exposure without a gate we verify,
  which is the one thing Cloudflare Tunnel is allowed here only because it has
  one.
- **Removing an origin from `TRUSTED_ORIGINS` on unpublish.** The Addresses
  card owns removal, and a publish that quietly edited someone's allowlist in
  both directions would be a second writer with opinions.
- **Encrypting the secrets store** (`SUBSHELL_SECRETS_KEY`, `docs/security.md`
  §8). Still deferred — now with one real customer, which is the condition that
  document named for revisiting it.

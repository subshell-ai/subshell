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
| `join` with a credential | `tailscale up --auth-key=<cred> [--hostname …]` | `tailscale up --login-server <settings.controlUrl> [--auth-key …]` | `netbird up --setup-key <cred>` (the `--management-url` variant was removed 2026-09-16 — see the § 10e bullet) | validate the token's shape (base64 JSON carrying `a`, `t`, `s`), `host.secrets.set("tunnel-token", cred)`, return `joined` |
| `join` interactive | `tailscale up`, capture `To authenticate, visit:` off `onLine`, then abort | same; the hint names `headscale nodes register` | `netbird up --no-browser`, capture the URL and code, then abort | not offered |
| `publish` | `tailscale serve reset`, then `tailscale serve --bg --https=443 http://127.0.0.1:<port>` | `tailscale serve --bg --http=80 http://127.0.0.1:<port>` (**measure**, §10.3) | no-op: the addresses are `http://<fqdn>:<port>` and `http://<netbirdIp>:<port>` | Access pre-flight (§6), then a `process` for `cloudflared tunnel run` and a `guard` |
| `publish` refusal | `CertDomains` empty ⇒ refused, naming MagicDNS + HTTPS certificates | — | — | settings incomplete, or the pre-flight fails |
| `unpublish` | `tailscale serve reset` | same | no-op | the host stops the process, then drops the guard |
| `leave` | `tailscale logout` | same | `netbird down` | delete the secret |
| `settingsFields` | none | `controlUrl` (required) | none (2026-09-16: the `managementUrl` field went — the daemon owns its config) | `hostname`, `teamDomain`, `aud` (all required), `tunnelToken` (`secret`) |

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
| `POST /api/network/:id/join` | `JoinInput` | `join()`. Frames: `line`* then `done: { outcome, status }` — **for a `publishImplicit` network the join IS the publish** (amended 2026-09-16, § 10e): it records the publish and runs the same `applyConfig` origin union the publish route drives, and its `done` also carries `{ config, restartRequired }`. Audit `network.join` `{ mode: "credential" \| "interactive", ok }`, plus `network.publish` `{ addresses, by: "join" }` on that auto-publish. An explicit-publish network's join writes nothing to config.env. | yes |
| `POST /api/network/:id/publish` | — (the `promoteBaseUrl` half was removed 2026-09-16, § 10e) | `publish()` → arm the guard → arm the process → `applyConfig({ trustedOrigins: existing ∪ addresses })` → `network.json.published = true`. `done: { addresses, config: { changed, warnings, written }, restartRequired: changed.length > 0 }`. Audits `network.publish` `{ addresses }` — the config write itself carries no audit row of its own. | yes |
| `POST /api/network/:id/unpublish` | — | the §5.3 sequence, subtraction included: the origins this network's publish added are subtracted from `TRUSTED_ORIGINS` through `applyConfig` (amended 2026-09-16). The response carries `{ config, restartRequired, origins }`; no kind is exempt — `publishImplicit` clears its record and subtracts its origins like every other (reversed 2026-09-16), `config: null` only when nothing was recorded. Audit `network.unpublish` `{ origins }`. | no |
| `POST /api/network/:id/leave` | `{ confirm: string }` (the plugin id) | the §5.3 sequence, then `leave()`. The response carries the removal trio `{ config, restartRequired, origins }` — for a `publishImplicit` network leave is the NORMAL strip path — and the audit names the origins. | no |
| `PATCH /api/plugins/:id { enabled: false }` (existing) | — | for a network plugin: the §5.3 sequence BEFORE `setEnabled`; 409 if it fails. It strips quietly — the same subtraction, answered in the plugins-route response shape rather than the trio — and the tell that it happened is the Server Settings → Service comparison of saved-versus-running `TRUSTED_ORIGINS`. Holds the per-plugin lock: 409 `EXISTS_ERROR` while a network act is running. | no |

Every refusal is decided **before any body opens** — the tmux-route rule
(§2.6):

| condition | status | code |
|---|---|---|
| not installed, not `network`, or disabled | 404 | `NOT_FOUND` |
| `process.platform` ∉ `network.platforms` | 409 | `PLATFORM_UNSUPPORTED` (new) |
| another operation in flight on this plugin (a module `Set<string>`) | 409 | `EXISTS_ERROR` |
| join or publish while the state is `not-installed` / `daemon-down` / `needs-privilege` | 409 | `NETWORK_NOT_READY` (new; the message is the first hint) |
| a required settings field unset | 409 | `NETWORK_UNCONFIGURED` (new) — **except a `secret` at JOIN**, which is exempt because the join's credential is how secrets arrive (amended post-review, § 10e; `publish` still demands them) |
| a `SupervisedProcessSpec` or a `run` argv would need sudo | 409 | `PRIVILEGE_REQUIRED` (new) |
| a Cloudflare publish whose Access pre-flight fails | 409 | `ACCESS_UNCONFIGURED` (new) |
| a malformed credential (the plugin's own shape check) | the join stream's terminal `error` frame, carrying the plugin's sentence | — (amended post-review: the body is open before the plugin runs, so no 400 can be chosen; the original row predates streaming) |
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
5. Subtract the origins this publish added from `TRUSTED_ORIGINS`, through
   the same `applyConfig` writer as the union, against the addresses
   captured BEFORE step 4 cleared them — an origin added by a publish has
   that publish's lifecycle (amended 2026-09-16; §5.4 and the §14 non-goal
   reversed with it).

**Steps 4 and 5 run for a `publishImplicit` network too (REVERSED
2026-09-16 the same day § 5.3 was first amended — the operator's ruling:
auto-add AND auto-remove, with the lifecycle).** The first cut kept the record
and the origins whole, arguing that an unpublish which cannot undo the
reachability must not pretend to undo the permission. The reversal accepts the
consequence instead: after an unpublish or disable a NetBird daemon MAY STILL
ANSWER at its own address — membership is what makes it answer — but the
stripped origins make that address stop ACCEPTING SIGN-INS once the restart
lands. A server that no longer describes a network does not keep trusting that
network's addresses, and that rule is worth more than the one exception it
costs; `leave`, the verb that actually takes the machine off, ends the
addresses anyway, so the common path loses nothing. A cleared record renders
`joined`, which is the truth: the host stopped describing this network as one
it publishes on.

**Guard-off is last.** Any other order leaves an instant in which a tunnel is
alive and unguarded, which for a `public-with-gate` plugin is the whole
exposure this design refuses to take. A failure at step 1 leaves the guard ON
and answers 409 with the supervisor's last lines.

### 5.4 Config writes

Both go through `applyConfig` (§2.7). There is no second writer, and that is
what makes `docs/security.md` §8's validator claims true of this feature
without restating them.

The `TRUSTED_ORIGINS` union is the only write, and it is
**passkey-neutral** — `promoteBaseUrl` and the route's rpID warning went on
2026-09-16 (§ 10e); the base URL is the Service page's field. It takes effect
at restart; the `done` frame says so and the SPA offers the existing
`RestartDialog`.

Removal is here now (amended 2026-09-16): unpublishing subtracts the origins
its own publish added (§5.3 step 5), canonical on both sides — and the
subtraction is by VALUE, not provenance. A hand-added origin that equals a
published address is indistinguishable from it in the file and leaves with
it; only origins no publish ever matched — the dev list the union seeded,
the addresses the Addresses card added by hand and no publish named —
survive every cycle. The same rules as the union: the only writer is `applyConfig`, an
environment-owned key is refused by name while the unpublish itself stands,
and an empty result CLEARS the key rather than writing an empty line. The
card's removal stays as the manual lever for origins this pair never wrote.
`restartRequired` is true only when a write actually landed; the SPA offers
the Service page's own `RestartDialog` beneath the result.

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
| 3 | **unmeasured, shipped so** | Phase 2's Headscale plugin shipped 2026-09-16 with this measurement still open — see the amendment at the end of this section. |
| 4 | **shipped, still open** | NetBird (phase 2) shipped, but this measurement is STILL UNMEASURED — see the amendments note below § 10a. The plugin degrades honestly: a socket error, a permission refusal and an unparseable body are ALL `daemon-down`, never `needs-privilege`, so it never relies on the peer-credential claim being true. |
| 5 | **open, degraded honestly in code** | Phase 3 landed (2026-09-16, `@subshell-ai/plugin-cloudflare-tunnel`) with no live Access team to measure against. The pre-flight passes ONLY on positive evidence of Access — the `Location` header or any `cf-access-*` header, if present — and treats every other answer, including a failed fetch, as a refusal; the exact status and header names remain unobserved. `--token-file` is NOT used at all, so its version floor is not this plugin's floor: the token is hydrated as the child's `TUNNEL_TOKEN` environment (`secretEnv`), which is the mechanism § 4.4 named as the expected route. Recorded with the other phase-3 results in § 10e below. |
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

**Amendment while building phase 2 (NetBird), 2026-09-16.** `@subshell-ai/plugin-netbird`
landed as the second network built-in. § 10.4 — the NetBird ≥ 0.76 peer-credential
authorisation the "no `needs-privilege` state" claim rests on — is STILL UNMEASURED;
no live NetBird daemon was available, and the plugin was written to not need it:
a socket error, a permission refusal and an unparseable `status --json` all map to
a single generic `daemon-down`, so the plugin never has to know which it saw, and
the `status --json` field spellings (the peer IP under `peerIP`/`ip`/`netbirdIp`,
the version under `netbirdVersion`/`version`) are each tried before the honest
`daemon-down`. A second, structural finding: a plugin whose publish runs no
command — NetBird's publish is host-side only, since a join already makes the peer
reachable — cannot observe the `joined → published` transition, because that
distinction lives in the host's trusted-origins config and `NetworkContext` carries
no `published` flag. NetBird therefore reports `joined` at best; making the card
read "Published" for such a plugin would need the host to merge its own `published`
record into `status.state`, which is an `apps/server/api` change deliberately not
made here. Recorded in the plugin's own `README.md` and `src/status.ts`.

**Amendment — the gap is closed, 2026-09-16.** It was closed the way § 4.5
delegates everything else: as manifest DATA. `subshell.network.publishImplicit`
(a boolean, refused otherwise by `parseManifest`) declares that a publish leaves
nothing the daemon can later be asked about, and `publishStateVisible`
(`apps/server/api/src/services/network/state.ts`) upgrades the plugin's own
`joined` to `published` when — and only when — the host holds a publish record
AND the flag is set. The merge runs in `buildNetworkRow` (the row, the wizard
chip) and in the boot report's `reportIfDown` (without which a healthy NetBird
warned "NOT publishing" on every boot forever). A plugin without the flag is
never upgraded: Tailscale's serve state is readable, so a reset from a terminal
must still show as `joined` whatever our record claims. NetBird's manifest now
carries the flag; the plugin's code still never reports a state it cannot see.

**Amendment (2026-09-16, phase 2):** #3 shipped unmeasured. The Headscale
plugin (`@subshell-ai/plugin-headscale`, spec 2026-09-16 § 4) was built to the
posture § 10.3's own text prescribes for a refusal: `publish` tries
`tailscale serve --bg --http=80 http://127.0.0.1:<port>` (reset first) and,
when the CLI refuses, returns a refusal naming § 10.3 as unmeasured and
pointing the operator at the plain `http://<DNSName>:<port>` address the
status already lists — never a fabricated `published` state. `status` treats
`CertDomains` as always empty regardless of what the daemon reports, so the
http-everywhere posture does not rest on the measurement either. The live
measurement remains an operator action (§ 9's out-of-scope stands); when it
happens, only the vendor table's publish row can change.

### 10d. What phase 3 must re-derive, and the refusal holding the place

A settings write does not re-derive anything, so `PATCH /api/network/:id/settings`
**refuses while the network is published** (409, "unpublish first"). Three
things would otherwise go stale, and the third is a security problem rather
than a display one:

1. the installed **request guard**, which keeps the hostname and audience it
   was built with — the interesting case being an admin CORRECTING a hostname,
   after which the row shows the new one and the guard names the old one with
   nothing saying so;
2. the supervised child's **argv**, for any plugin that embeds a setting in it;
3. the **hydrated secret**. The child holds the credential it was spawned with,
   so an admin rotating a leaked Cloudflare tunnel token would see the field
   report `set` and the process report running while the old token stayed live.
   A rotation that silently does not apply, on the one credential class §9
   introduces.

Phase 3 replaces the refusal with a re-derive of all three plus a re-arm. The
refusal is deliberately the thing standing there in the meantime: phase 3 has
to DELETE it to get the wrong behaviour, rather than remember to go looking for
a bug — the same reasoning that puts the harness/network split at one accessor
instead of at five call sites.

Reachable by nobody today: the shipping Tailscale plugin declares no settings
fields, so every key in such a write is unknown and the route 400s before this.

### 10e. Phase 3 as built (2026-09-16) — what the first `supervise`/`guard` consumer changed

The Cloudflare Tunnel plugin is the first real use of the two capabilities
phase 1 shipped declared-but-unused, and being first turned up three things
§ 4–6 had specified but no code had yet exercised. Each is recorded as built,
because a later reader should find the decision, not the discrepancy.

- **`supervisedProcess` may return a promise** (widened in
  `@subshell-ai/plugin-api`, awaited by `prepare.ts`). The spec demanded an
  absolute `command` resolved through `findBinary`, `findBinary` is async,
  and boot re-asks the member on a fresh process before any earlier call
  could have cached a path — a synchronous-only member means a supervised
  plugin arms NOTHING after a restart, silently breaking § 5.5. No vendor
  measurement was needed to find this; the type checked and the runtime
  armed a Promise as a spec.
- **The host merges `published` into the row** (§ 4.5's "the host merges that
  in", unimplemented until there was a plugin that needed it):
  `buildNetworkRow` promotes a plugin's `joined` to `published` when the
  supervisor reports that plugin's child running, and only for plugins that
  declare `supervisedProcess` — for the mesh class, `status()` reads its own
  daemon and remains the authority. `reportIfDown` gets the same scoping from
  the other side: a supervised plugin with an armed child gets no boot
  warning, because the supervisor's own state is its health line and
  `status()` honestly cannot see it. The plugin answers presence and
  completeness and never process state, exactly as phase 2-3 § 6 specified;
  this is the host keeping its half of that sentence.
- **The secret's field key is `tunnel-token`, not the spec's `tunnelToken`.**
  The PATCH route stores a secret field under the declared field's KEY, and
  secret names are file names (`NAME_RE`: lowercase, digits, hyphens), so a
  camelCase key makes the field permanently unsettable — the store refuses
  every write by name, `ctx.secrets.has` answers false forever, and publish
  refuses with "paste the token" no matter what was pasted. The dashed key is
  the one spelling consistent with § 4.4's own storage rules.
- **`install.command` is not platform-scoped.** § 7.1 anticipated an Install
  button "when `install.command` exists for this platform"; the manifest's
  `install` block is one command for the whole plugin. The button therefore
  renders wherever the plugin is supported, and on a Linux host without
  Homebrew the press streams the installer's own failure beside the apt-repo
  step the card already prints. Gating it per platform is a UI/manifest
  change phase 3 was explicitly out-of-scope for ("Any UI change"); shipping
  the command as spec'd (§ 4.5/§ 8) with the Linux path covered by the
  privileged step is the choice made here.
- **No `readyPattern` on the process spec**, because § 10.5 stayed unmeasured
  and a guessed ready line that never matches would leave a working tunnel
  reported not-running forever (which, with the merge above, is also a row
  stuck at `joined`). Alive-is-ready is the contract's own fallback; § 10.5
  keeps the row open for a live measurement to replace it.

The § 10d settings-write refusal **still stands**: phase 3's plugin works
against the refusal (unpublish → edit → re-publish), and replacing it with
the three-part re-derive is a server behavior change beyond this plugin. The
refusal is the safe default until someone builds and tests the re-derive.
- **The join gate exempted required secrets (post-review, same day).** The
  phases-2/3 review found the Cloudflare Connect button structurally dead:
  `configurationRefusal` gated JOIN on every required field, the token is a
  required `secret`, and the join is the act that writes the store — so the
  first press could only 409. The gate now takes the act; `"join"` skips
  required secrets and only them (`network-gate.ts` docblock carries the
  rule), `"publish"` stays strict. No plugin before cloudflare had a required
  settings field AT ALL, which is why phase 1 never met the contradiction.
- **The pre-flight passes on positive evidence at ANY status**, not only the
  302/403 § 6 named: any response carrying a team-login `Location` or a
  `cf-access-*` header passes. Only positive evidence passes either way —
  the loosening is over status codes, never over the headers — and § 10.5's
  unmeasuredness is exactly about which status the edge uses.
- **Two paths write the tunnel token, with different strictness.** The join
  shape-checks before storing; `PATCH /:id/settings` stores the raw string
  (`validateSettings` deliberately never sees secret values — a plugin
  cannot read one back to check it). A malformed token pasted into the
  settings form therefore reaches the connector and fails there, which is
  the failure the join's shape check exists to pre-empt. Accepted as
  contract-inherent for now; the real fix is a host-run per-secret shape
  check that never hands the plugin the value, and it is not this batch's.

- **Both Tailscale-family rows now police daemon ownership (amended
  2026-09-16, on the operator's live host).** § 8 pairs the two rows as one
  binary pointed at two control servers, and the shipped posture was that the
  status cannot tell which control server a daemon belongs to, so the code
  deliberately did not police it. The first half is true of the call it was
  measured on — `status --json` has no `LoginServer` key on CLI 1.102.4 — but
  `tailscale debug prefs` (unprivileged, same binary, small JSON) does answer:
  `ControlURL` is `https://controlplane.tailscale.com` for a machine enrolled
  the ordinary way and the operator's URL for one enrolled with
  `--login-server`. So the non-policing decision is REVERSED where the
  evidence is positive and STANDS where it is not. Each row now asks prefs
  before claiming a `Running` daemon: the Headscale row owns it only when the
  reported `ControlURL` canonicalizes (trailing slash and host case folded)
  to the configured `controlUrl` — unset or unparseable counts as not-a-match,
  since a join requires the URL — and the Tailscale row only when it
  canonicalizes to the service default. A daemon naming the other network
  answers `needs-login` with a hint naming where it actually goes (the
  Headscale one offers a copyable `tailscale logout`, suggested and never
  run), with empty addresses, and neither row reads the foreign daemon's
  serve config — a phantom "Publish" was the same defect one state further.
  Prefs unreadable or `ControlURL` absent/empty fails OPEN to the
  pre-amendment read, which is what keeps the README's pick-one rule the last
  word on older CLIs. The measurement that started it: a Headscale row
  reading "Joined" on a host whose daemon serves the SaaS, with the machine's
  `debug prefs` naming `controlplane.tailscale.com`.
- **The joined sentence quotes the row's own label (amended 2026-09-16).** The
  card's standing sentence said "publishing is what lets your other devices open
  this dashboard" on every row, silently assuming four plugins that name the act
  four ways — Publish, Publish with Tailscale Serve, Start tunnel, Use this
  address — share the word "publishing". NetBird's button reads **Use this
  address**, and an operator met two names for one act and asked how to publish.
  The sentence now renders `row.labels.publish ?? "Publish"` — the same expression
  the button itself uses, in quoted form — so copy and control cannot disagree.
- **Address rows take the line-item grammar (amended 2026-09-16, on the
  operator's live Headscale and NetBird cards).** Each row had been the URL as
  the loud thing — `font-strong text-label`, a second heading — with the kind
  tag trailing it small and muted (`http://macbook-pro…:3080   NetBird FQDN`),
  and the operator read the two as disjoint. The design system's line item puts
  the label ABOVE the value, so each `<li>` is now the kind label in the
  form-label grammar (`font-strong text-label`, the same classes as a "Control
  server URL (required)" label), the URL beneath it as a value at body size,
  and the secure-context sentence exactly where it was — still one per address,
  comparative by repetition, undeduped for the reason its docblock defends.
  One component, so all four plugins move together.
- **The connect refusal says SAVE, and keeps the label's casing (amended
  2026-09-16).** "Set the control server url first." was wrong twice over.
  It named an act nothing on screen performs: the blocker fires in exactly one
  state — the field is typed into the settings form and its **Save** button has
  not been pressed (or it was never typed) — so the sentence now says
  `Save the ${label} first.` And the wholesale lowercasing renamed the thing
  the form asks for: the field is labelled "Control server URL", and a
  sentence reading "control server url" sends the reader hunting for a second
  field. The label is quoted verbatim, so the sentence and the control name
  the same box.
- **`labels.credentialDocsUrl`: a Docs link beside the credential box (amended
  2026-09-16).** The needs-login card could name what to paste ("Auth key",
  "Setup key", "Tunnel token") while saying nothing about where one comes
  from — knowledge only the vendor has, so only the manifest should carry it.
  The labels block gains one optional member, gated by `isDocsUrl` at parse
  like every other URL the contract carries (a bad value is refused at load,
  not dropped), passed through the row's `labels` by `network-view.ts`'s whole-
  object mapping and declared on the response schema — Elysia strips
  undeclared fields, so the schema is what makes it cross the wire, and
  `network-routes.test.ts` now pins the whole block survives. The card renders
  it through `safeHref` as a `Docs ↗` sibling on the label row — the Label
  keeps pointing at the input. All four built-ins carry their page.
- **How to join is a mode choice, rendered by `Segmented` (amended
  2026-09-16, on the operator's live Headscale card).** The `needs-login` block
  was a credential box above two sibling buttons — Connect, and Sign in with
  Headscale — and the operator read it exactly backwards: the big empty field
  at the top looked required, when it is the OPTIONAL path's credential, and two
  buttons side by side looked like related acts on one form rather than two
  mutually exclusive ways to join. Now one control carries the choice
  (`Sign in` | `Use auth key`, the credential word lower-cased out of the same
  `labels.credential` the Label uses) and exactly ONE panel sits under it: a
  thing absent until asked for cannot be misread as a thing to fill in.
  `Segmented` rather than a tab strip because it is this app's established mode
  switch — the tiled/list view toggle, the add-subshell dialog, the
  split-placement picker — and this is that kind of thing: two ways to do one
  act, not two pages. Default `signin`, because the human sitting at this page
  is the common case and a pasted key is what an automation or a headless host
  brings. `blocker` — the server refuses EITHER join while a required setting is
  unset — moved under the choice and stays on one paragraph wired to both
  buttons. A single-path plugin (`cloudflare-tunnel`: no interactive path, and
  the only built-in with a secret settings field, so the "paste it into the
  Connect box" note never sits above a panel someone may be looking away from)
  gets no choice at all — one road needs no fork drawn on it. The login URL and
  code stay OUTSIDE the choice, below it: they arrive from the join stream or
  the poll regardless of which panel is up, and switching tabs mid-sign-in must
  not hide the link the person was told about.
  The same card, read again a few minutes later, asked for two more things. The
  strip and its panel now share ONE border (`rounded-md border p-4`, the
  sign-in-link block's own bounded-control language) because a pill group with
  content loose beneath it reads as a widget floating above orphaned text — and
  the border appears only where there is a choice to scope, so Cloudflare's
  single-path block keeps the plain flow. The strip also hugs its labels
  (`className="w-fit"`), since every other `Segmented` in the app sizes to its
  content and a card-wide bar with two buttons at one end reads as a tab strip
  for pages that do not exist. No visible "How to connect" caption above the
  pills: the fieldset already carries that as its accessible name, so a heading
  repeating it is the same words read twice, and the panel sentence already says
  what the chosen path does.

- **The two label grammars are named, and the address rows move to the quiet
  one (amended 2026-09-16, same card read a third time).** The bullet above put
  each kind label in the FORM-label grammar, and that was half wrong: the rows
  are read-only data, so the card ended up holding both grammars six pixels
  apart — bold "NetBird FQDN" over its URL beside quiet "Client version" over
  its, from the `Fact` block above. The operator's question was the tell: "why
  is one bold and the other not?" One component renders all four plugins, so one
  change moved every address row to the `Fact`/`dt` grammar — `text-muted-foreground`,
  no weight token, `text-sm` carried by the list exactly as the `<dl>` carries
  it — value and secure-context sentence untouched. Two more elements came out of
  the walk that followed, over every data-bearing element in the card: the
  base-URL checkbox's label had the `label` size without its weight (a 400 over a
  control where every other control on the page is 600), and the restart notice
  rendered the same sentence at two sizes depending on whether
  `GET /api/admin/server` had landed. `docs/design-system.md` now states the rule
  — quiet labels for data, `font-strong` for a control's label and a section
  heading — as a named pattern rather than as four local class choices.

- **Publishing becomes a section of the joined card, with its necessity
  answered (amended 2026-09-16, operator read of a live Tailscale row).** The
  joined state flowed facts, the state sentence, the plugin's hints and the
  publish controls as one column, and the reader could not tell whether the
  press was required — "it's not clear to me if the user needs to or not."
  The act now sits in its own bounded group (the join-mode box's language)
  under a `Publish` heading, positioned BELOW the plugin's hints so
  Tailscale's certificate-transparency cost reads as the section's preamble
  rather than as prose about the addresses above; the section's second line
  states the case where skipping is honest — this machine only, or an address
  the server already allows. The published half keeps its bare standing
  sentence: a fact among the readout, not a re-asked question. Three directly
  fixed siblings ride the same changeset: the membership facts regained the
  fact card's columns, every address is copyable in every state (the prop
  that gated copying to `published` called a live mesh address "a preview"),
  and the address values settled to the list's size.

- **The publish section speaks each network's truth, and a cross-network
  base-URL move is confirmed (amended 2026-09-16, operator read of the live
  NetBird card: "I don't think netbird has a publish concept?").** It does
  not — `publishImplicit` was invented precisely because joining makes
  NetBird's addresses answer and the press records them on THIS server's
  side only; the "Publish" heading and "Subshell is not published on NetBird"
  borrowed the Serve/tunnel vocabulary for a mechanism the vendor has no
  name for. For implicit-publish networks the section is headed **Other
  devices** and its sentences describe the allow-list act; the Serve/tunnel
  wording stands where it describes a real vendor mechanism. The same read
  asked what happens when TWO plugins both tick "Set as this server's base
  URL": the checkbox is per-card and `APP_BASE_URL` is one value, so the
  second press silently re-points the server and the passkey rpID with it.
  Off loopback that is the checkbox's documented purpose and publishes
  straight through; off another network's established address the press names
  both hosts and asks (one pure function, `lib/base-url-move.ts`, tabled —
  including WHATWG `URL.hostname` keeping brackets on IPv6, caught by its own
  test).

- **The page states the server's address; the legend that explained the states
  is gone (amended 2026-09-16, operator read of the finished page).** Two
  halves of one request. The sentence above the network lists — "Joined means
  this machine is on the network. Published means…" — was deleted rather than
  reworded: by this point the cards and the publish section explain that
  difference where the states actually appear, and a definition read once
  above a list of rows explains a legend nobody consults. What the page prints
  instead is the answer every card's promote checkbox competes for, in one
  line: the address the server is RUNNING as and which network's address list
  contains it ("This server's address: http://box… — over Tailscale"), plus a
  second clause only when a saved promote has not taken effect yet
  ("Saved for the next restart: …"). The split is honest about the mechanism —
  `APP_BASE_URL` is a boot-time constant, which is exactly why the publish
  flow's `restartRequired` is always true — and the line reads the SAVED value
  from the deployment view at 60 s, the `/settings/status` Locations card's
  reason: `/api/admin/server` runs its service and port probes synchronously,
  and the publish mutation already invalidates that key, so the pending half
  appears the moment the act that writes it lands. The attribution is a pure
  function, `lib/network-base-url.ts`, comparing ORIGINS not strings (a serve
  address carries `:3080`, a base URL usually does not) and attributing
  nothing when no address list claims the origin or the stored value will not
  parse.

- **The base-URL promote checkbox is gone (amended 2026-09-16, operator
  read of the finished page).** "It caused a lot of confusion", and the shape
  explains why: a checkbox that silently moves the passkey rpID sat inside a
  flow about REACHING the server rather than one about its identity, every
  card carried its own copy, and the value it wrote was the instance's one
  `APP_BASE_URL` — so two cards pressing it moved the server, and the
  passkeys, from wherever the first had left them; the cross-network
  confirmation the first read prompted only made the confusion denser. Out
  went `promoteBaseUrl` on the publish body, the gate's `baseUrl` half, the
  route's rpID warning and `lib/base-url-move.ts` together. Publishing now
  writes `TRUSTED_ORIGINS` alone; the base URL is set where the rest of the
  server's config is set — Server Settings → Service — where moving the rpID
  is the field's own stated consequence.

- **Origins have the lifecycle of the publish that added them, and the
  restart that lands the change can be taken from the result that needs it
  (amended 2026-09-16, operator: "we should just auto-add / remove to
  trusted origins for the plugins. if it requires a restart then perform
  that action after user confirmation in the same step if possible").**
  Publishing already added; unpublishing now subtracts — the sequence
  captures the recorded addresses before clearing them and the gate's
  subtraction writer removes exactly them through `applyConfig`, with the
  union's honesty rules whole: an environment-owned key is refused by name
  while the unpublish stands, an absent or unmatched line writes nothing,
  an emptied one CLEARS. The answer rides the response
  (`config`/`restartRequired`/`origins`), and one result component serves
  both acts: warnings, the refused key, and the Service page's own restart
  button and pane-safety dialog beneath either, with the card holding the
  one waiter — its `waiting` outcome locks every act on the card and its
  `back` outcome refetches the rows and the public settings without a
  reload. NetBird strips too — its press first kept its record and origins
  whole, and the operator reversed that the same day: after a disable the
  daemon may still answer at its address, and what stripping ends is
  sign-in ACCEPTANCE there at the restart, the stated and chosen cost of
  letting a publish own an origin's lifecycle (§ 5.3, amended twice
  2026-09-16). §5.4 and the §14 non-goal are updated with it; the unpublish
  route stayed a delegation to the one sequence throughout.

- **Joining IS the publish for a `publishImplicit` network (2026-09-16,
  operator read of the NetBird card next to the same sentence: "do we really
  need this?").** The separate press was the box the previous bullets kept
  redecorating; on NetBird it was recording what membership had already
  done, under a heading the vendor has no word for. The join route now
  does, on a successful join of an implicit network, exactly what the
  publish route does — `writeNetworkState` and the gate's own
  `writePublishConfig` (shared, deliberately: two writers would be two
  sets of union and env-ownership rules to keep honest), reporting the
  write and the restart answer on the join's `done` frame
  (`config`/`restartRequired`), and auditing a `network.publish` row of
  its own `{ addresses, by: "join" }` so the audit vocabulary stays
  countable and the two rows say why they share one press. Measured
  behaviour (§ 10.4: NetBird 0.66.4 answers `status` with its addresses
  the instant a join lands) means no poll: ONE honest re-read after 1.2 s
  covers the case the measurement cannot promise, and a row still empty
  goes on joined-and-unrecorded. That gap state is all the card shows the
  old affordance for now — one sentence and the existing button, no box,
  no heading, no skip paragraph: the rare fallback must not wear the
  furniture of the normal path. Explicit-publish networks are untouched
  (their presses carry the real costs — public CT logs, a public tunnel —
  and stay user-decided), and their join still writes nothing to
  config.env. The § 5 join row and § 5.3's lifecycle text carry it;
  NetBird's `labels.publish` — "Use this address", the box's whole
  vocabulary — now serves only the fallback button, a copy call left to
  the plugin.

- **NetBird keeps no configuration (amended 2026-09-16, operator read of a
  live joined row: "the user should configure all of this in their own
  netbird cli setup").** The "Management URL (self-hosted only)" field died
  at the manifest, not the disclosure: it fed only `netbird up
  --management-url` at join, and post-join the daemon's own config owns the
  management service — a card copy of it could only disagree with the
  machine. The plugin now declares no `settingsFields` and drops the
  `settings` capability with them (the load-time mismatch check pairs them
  BOTH ways, so half a removal would refuse the plugin), the join argv
  shrinks to `netbird up [--setup-key …]` / `netbird up --no-browser`, and
  the setup KEY survives because it is a join credential, not
  configuration. Zero-field plugins became a tested card shape at the same
  time: no disclosure opens onto nothing (`collapseSettings` checks
  `settingsFields.length`), and the implicit gap fallback stands alone.

### 10f. Origins are derived, not written (2026-09-16) — the live trusted-origin registry

Measured on a `HOST=0.0.0.0` instance joined to a tailnet:
`http://100.117.173.95:3080` served the app (200) and a sign-in with that
Origin was 403 "Invalid origin". Reachability was a network fact; the
allowlist was the only thing in the way, and it was read once at boot.
§ 5.4's "a publish adds its origins to `TRUSTED_ORIGINS`" and the 2026-09-16
subtraction amendment are both superseded by this section.

- **Network origins are DERIVED from plugin state, live.**
  `services/trusted-origins.ts` assembles
  `localOriginsFor(...) ∪ operator TRUSTED_ORIGINS ∪ ⋃ enabled plugin p:
  originsOf(p)` on demand; better-auth (function-form `trustedOrigins`,
  called per request in 1.7.1) and the CORS predicate read it.
  `writePublishConfig`, `removePublishedConfig`, `unionOrigins`,
  `subtractOrigins`, `keyOwnWarnings` and `prepare.ts`'s
  `writeTrustedOrigins` are deleted. config.env's key is the operator's
  extras only; entries earlier publishes wrote there are left as harmless
  extras (no installed base).
- **`restartRequired` is gone from every network act.** Unpublish and leave
  answer `{ ok, origins, status }` (`origins` = what stopped being trusted,
  as of the answer — a `private` network's unpublish is normally empty,
  because membership keeps its addresses trusted, while the audit row and
  the record name what the publish had held); publish's done frame is
  `{ type, ok, addresses, status }` and join's is `{ type, outcome, status }`;
  `NetworkConfigWriteSchema` and `NetworkRemovalResponseSchema` are deleted.
  `PATCH /api/admin/server/config` still writes the key and the registry
  reloads it, so the operator's list is live too and never contributes to
  the deployment view's `restartRequired`.
- **Trust scope by exposure.** `private` (Tailscale, Headscale, NetBird):
  every address the plugin reports at `joined` or `published` —
  `http://<ip>:<port>` answers with no `serve`, so membership is the honest
  scope. `public-with-gate` (Cloudflare Tunnel): only from a record with
  `published: true`, because the Access guard is armed before a publish
  completes and never before.
- **The record's `addresses` mean "where this host is on that network."**
  Updated on every uncached status read that answers joined/published
  (`readNetworkStatus`), on publish (result), and by boot's `reportIfDown`;
  kept across an unpublish; cleared on leave, disable and uninstall, each of
  which also forgets the plugin in the registry. Re-enabling trusts the
  record at once and probes once.
- **Boot seeds from records before the listener, probes once after the
  processes, then refreshes every `ORIGIN_REFRESH_MS` (5 min).** A stated
  exception to "detection is never a timer" (§ 5.5's `reportIfDown`
  reasoning): the allowlist is consulted on every sign-in by people who
  never open the Networking page, and the cost is one memoised `status()`
  per enabled plugin per five minutes, skipping supervised plugins whose
  child is armed. Refreshes are observations: info-logged when the set
  changes, never audited.
- **Every plugin origin is canonicalized with `URL.origin` and refused if
  unparseable, if it serializes to `"null"`, or if it carries `*`/`?` in the
  origin component (the authority region)** — a pattern character in the
  path or query is discarded by `URL.origin` and can never reach the stored
  list. A refusal is dropped with a `warn` naming the plugin and the value,
  never thrown. Nothing in the registry ever comes from a request's
  Host/Origin header.
- **CORS matches exactly.** The plugin's string branch also accepted a
  schemeless entry by stripping the incoming scheme; the function predicate
  does not, closing the scheme-wildcard noted in security-context.md.
- **Disable is a network act.** The Networking card offers Disable/Enable
  through the existing `PATCH /api/plugins/:id { enabled }`; a disabled
  plugin contributes nothing and its card says what it withholds.

### 10c. The one operator action phase 1 left outstanding — DONE 2026-09-16

**Closed.** `@subshell-ai/plugin-tailscale` was published by hand at `0.0.1`,
its trusted publisher was configured with
`npm trust github @subshell-ai/plugin-tailscale --file release.yml --repository
subshell-ai/subshell --allow-publish --allow-stage-publish` (matching what the
other seven carry, no environment), and the ignore entry was removed. So the
next push publishes `0.1.0` from CI with provenance, and `0.0.1` is the only
version of it without an attestation — the same shape as the other seven. The
rest of this section is why it was needed and is kept because the reasoning
applies to the ninth package, not just the eighth.

`@subshell-ai/plugin-tailscale` was an eighth `@subshell-ai/*` package and npm
trusted publishing cannot be configured for a package that does not exist. It
was therefore in `.changeset/config.json`'s ignore list — beside ten workspaces
ignored for the opposite reason, which are not independently released at all.

**Two separate mechanisms, and an earlier draft of this section conflated
them.** The ignore entry is read by `changeset publish` (through
`getUnpublishedPackages`), so the package is skipped when a publish runs. It is
NOT read by `release.yml`'s own `unpublished` probe, which globs
`packages/plugins/*/package.json` and asks the registry about each — so a 404
for an unbootstrapped package set `needs_publish` and woke the hosted
`npm-publish` job on every push, to publish nothing. Hosted minutes are
metered, so that is a bill rather than a nuisance. The probe now skips
packages the changesets config ignores, which is what makes the two agree.

**Publish it by hand once, configure the trusted publisher, then remove it from
the ignore list** — in that order, because `changeset publish` will sweep up any
workspace package whose version the registry lacks, and the publish job holds no
token to fall back on when OIDC is not yet configured. Until all three are done
the plugin ships inside the server binary (it is a compiled-in built-in, so
nothing a user does depends on the registry) and is simply not separately
installable.

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
  Joined-and-unrecorded on an implicit-publish network — the gap only, since
  joining now records it (§ 10e) — is one line, no section: *<Name> publishes
  by joining — "Use this address" records its addresses and trusts them for
  sign-in.*
- published: *Subshell is published on <network>.*

**Secure context**, under each address, verbatim:

- *Passkeys and secure cookies work at this address.*
- *Encrypted by the network, but your browser sees plain http: passkeys and
  secure cookies will not work here.*

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
  benefits when the operator names it in the base URL (Server Settings → Service) or repoints it with
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
- **Removing an origin from `TRUSTED_ORIGINS` on unpublish — REVERSED
  2026-09-16.** The Addresses card owned removal, and a publish that quietly
  edited someone's allowlist in both directions would be a second writer
  with opinions. The operator reversed it the same day: an origin added by a
  publish now has that publish's lifecycle (§5.3 step 5). The "second writer"
  fear is answered the way it always was — the subtraction runs through
  `applyConfig`, under the same validator, never beside it. The accepted
  consequence is the one this non-goal existed to avoid: an address a phone
  was signed in on can stop accepting NEW sign-ins at the restart while the
  daemon may still answer there — most of all on the implicit-publish kind,
  whose first cut left its record and origins standing: the exception the
  reversal knowingly costs — and lifecycle ownership was chosen over that.
- **Encrypting the secrets store** (`SUBSHELL_SECRETS_KEY`, `docs/security.md`
  §8). Still deferred — now with one real customer, which is the condition that
  document named for revisiting it.

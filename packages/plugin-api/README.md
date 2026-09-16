# @subshell-ai/plugin-api

The contract a [Subshell](https://github.com/subshell-ai/subshell) plugin
implements.

A plugin teaches Subshell how to drive one agent CLI: how to build its launch
command, how to register the cross-subshell MCP server with it, and what its
settings are. Subshell ships six built in (Claude Code, Codex, OpenCode,
Hermes, pi, and Terminal — a plain shell that drives no agent CLI); this
package is what you build against to add another.

A plugin can also teach Subshell how to **connect its host to one network** and
publish the server there — a mesh VPN, or a tunnel. Same package, same store,
same install door, different interface: see [Network plugins](#network-plugins)
below.

## The one thing to know first

**A plugin cannot import anything of Subshell's at runtime.** It is loaded
from disk by a compiled binary, which has no `node_modules` beside it, so a
bare specifier does not resolve. Everything the host lends you arrives through
a `PluginHost` handed to your factory, and your build must inline this package
rather than leaving it as an import.

That single constraint explains the whole shape below.

## A complete plugin

`package.json` carries the identity, so the host can list your plugin and
detect its binary without importing or running a line of your code:

```json
{
  "name": "@you/plugin-mytool",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "subshell": {
    "apiVersion": 2,
    "id": "mytool",
    "type": "agent-harness",
    "name": "My Tool",
    "description": "What it is, in one line",
    "entry": "dist/index.js",
    "detect": {
      "binaryName": "mytool",
      "envOverride": "MYTOOL_PATH",
      "knownPaths": [".local/bin/mytool"]
    },
    "install": { "command": "npm i -g mytool", "docsUrl": "https://example.com/install" }
  },
  "devDependencies": { "@subshell-ai/plugin-api": "^2.0.0" }
}
```

A preset is an optional saved customisation for one harness — the host builds
a launch on no preset at all by handing `buildCommand` an empty one.
`src/index.ts` default-exports a factory:

```ts
import {
  type PluginCapability,
  type PluginFactory,
  type PluginHost,
  type SubshellPlugin,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

const createPlugin: PluginFactory = (host: PluginHost): SubshellPlugin => ({
  capabilities: (): PluginCapability[] => ["settings"],

  buildCommand({ binary, preset, subshellName, extraFlags }) {
    const args = [binary];
    const model = preset.settings?.model;
    if (typeof model === "string") args.push("--model", model);
    if (subshellName) args.push("--name", subshellName);
    args.push(...preset.flags, ...(extraFlags ?? []));
    return args;
  },

  validatePreset: (preset) => validateGenericPreset(preset),

  presetSettings: () => [
    { key: "model", label: "Model", type: "string", description: "Model name" },
  ],
});

export default createPlugin;
```

Bundle it so the output imports nothing but node builtins. With
[tsdown](https://tsdown.dev):

```ts
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  noExternal: ["@subshell-ai/plugin-api"],
});
```

## Type is for humans, capabilities are for code

`type` (`agent-harness`, `terminal`, `network`) groups and labels your plugin in
the UI. What the launch pipeline branches on is `capabilities()`, and it is
checked: declare `resume` without a `resume` object and the host refuses to load
you, rather than letting a restart silently begin a fresh conversation.

**The capability union is shared; the applicable SET is per type, and that is
validated too.** A harness declaring `publish`, or a network plugin declaring
`resume`, is refused by name at load — not ignored — because a silently dropped
capability leaves whatever it implements unreachable with nothing said.

| capability | type | what you must implement |
|---|---|---|
| `mcp` | harness | `mcpRegistration` (a per-subshell config file) or `mcpSetup` (one-time manual steps) |
| `resume` | harness | `resume.allocateHarnessSessionId` and the pure `resume.resumePath` |
| `attention` | harness | `supportsAttentionHooks: true`, with the hooks wired in `buildCommand` |
| `publish` | network | **both** `publish()` and `unpublish()` — a publish nothing can undo is not a capability |
| `supervise` | network | `supervisedProcess()` |
| `guard` | network | `requestGuard()` |
| `settings` | both | `presetSettings()` on a harness, `settingsFields()` on a network plugin |

"harness" here means `agent-harness` or `terminal`: the two types that
implement `SubshellPlugin` and launch panes.

## Network plugins

A `type: "network"` plugin connects the host to one network and publishes
Subshell on it. It implements `NetworkPlugin` rather than `SubshellPlugin`, and
the loader picks which members to require from your manifest's `type`, so a
network plugin that returns a harness is refused with the members it is missing
rather than loaded and left to fail at the first call.

### The rule: you describe, the host executes

You return argv, parse output, and name a secret. You never spawn a process,
never write a file, never touch the server's configuration, and never read a
credential back. Every effect goes through a `PluginHost` member the host owns.

That is what makes the whole thing defensible: the host's spawn is
admin-gated, bounded by a deadline and an output cap, and runs under an
environment allowlist rather than the server's own environment. If you spawned
your own child, none of that would be true of it.

```ts
interface NetworkPlugin {
  capabilities(): PluginCapability[];
  status(ctx: NetworkContext): Promise<NetworkStatus>;
  join(input: JoinInput, ctx: NetworkContext): Promise<JoinOutcome>;
  leave(ctx: NetworkContext): Promise<void>;

  publish?(ctx): Promise<PublishOutcome | PublishRefusal>;
  unpublish?(ctx): Promise<void>;
  supervisedProcess?(ctx): SupervisedProcessSpec | null;
  requestGuard?(ctx): RequestGuardSpec | null;
  settingsFields?(): SettingsField[];
  validateSettings?(values): PresetValidationIssue[];
}
```

`status` is your only reporting surface — the host renders what it returns and
infers nothing. It runs on every page load and before every act, so make it
cheap, and never throw from it: an unreachable daemon is `daemon-down` with a
hint, not a rejection. A `PublishRefusal` is likewise an answer rather than a
failure; it carries a hint to render ("enable HTTPS certificates in the admin
console") instead of an error to log.

### A URL you report becomes a link, so it is checked

Anything you put in a `docsUrl` — on a hint, on an `install` block, on a
privileged step — is rendered as the `href` of an anchor on an admin's page.
An `href` is not inert, so **only `http:` and `https:` are accepted**, and the
two halves fail differently on purpose:

- A `docsUrl` in your **manifest** is static data, so a bad one is a defect in
  your plugin and the parser refuses to load it. `isDocsUrl` is exported if you
  want to check it yourself in a test.
- A `docsUrl` on a hint you report at **runtime** is dropped by the host, and
  the hint's sentence is kept. Refusing your whole plugin there would be wrong:
  the value often is not yours.

That last case is the one worth designing around. If you read a URL out of a
vendor CLI, the CLI read it from its control server, and on a self-hosted
deployment that server is not the vendor's. Tailscale's `AuthURL` under
`--login-server` is exactly this. Validate it where it enters your plugin and
report nothing rather than passing it along — the host's drop is a backstop,
not your input validation.

### The manifest block

Required when `type` is `network`, refused on any other type:

```json
"subshell": {
  "apiVersion": 2,
  "id": "mynet",
  "type": "network",
  "name": "MyNet",
  "description": "What it is, in one line",
  "entry": "dist/index.js",
  "detect": { "binaryName": "mynet", "envOverride": "MYNET_PATH", "knownPaths": [] },
  "network": {
    "platforms": ["darwin", "linux"],
    "interactiveLogin": true,
    "exposure": "private",
    "privileged": {
      "darwin": [{ "label": "Install the daemon", "command": "sudo mynet service install" }]
    }
  }
}
```

All of it is data a host reads without importing your code, which is the point:
a page can say "not available on this platform" or print your two `sudo`
commands before your CLI is anywhere on the machine.

**`privileged` is the copy-only channel and `install.command` is the runnable
one.** Every mesh daemon needs one root install, and the host has no terminal
to answer a password prompt — so the manifest parser refuses an
`install.command` that starts with `sudo`, and `host.run` throws on an `argv[0]`
whose basename is `sudo`, `doas` or `pkexec`. Put anything privileged under
`network.privileged`, where a page prints it for a human to run.

`exposure` is never defaulted. `private` is a network only invited machines are
on; `public-with-gate` reaches the open internet with an identity check in
front, and every surface states that before the publish button.

### You hold no state

`NetworkContext` carries the server's port, your stored non-secret settings,
and which of your secrets are set — on **every** call:

```ts
interface NetworkContext {
  port: number;
  settings: Record<string, string>;
  secrets: { has(name: string): boolean };
}
```

Do not remember the port you published on, what your settings were, or whether
you hold a credential. A plugin reloaded mid-life then behaves identically to
one that has been running since boot, and a server port that changed between
two calls is simply the new port. The host asks `supervisedProcess()` and
`requestGuard()` again at every boot for the same reason: a rotated credential
or a changed port takes effect on the next spawn without anyone re-publishing.

### Why `host.secrets` has no `get`

```ts
secrets: {
  set(name: string, value: string): Promise<void>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<void>;
};
```

A plugin that can READ a credential can put it in an argv (visible in `ps`), in
a log line, or in a hint string that renders in somebody's browser. Every
legitimate consumer is a process the host spawns, so the host hydrates the value
itself from the name you gave it:

```ts
supervisedProcess: () => ({
  command: resolvedBinary,            // absolute, from host.findBinary
  args: ["tunnel", "run", "--no-autoupdate"],
  secretFileArgs: { "--token-file": "tunnel-token" },   // host writes 0600, appends the path
  // or: secretEnv: { MYNET_TOKEN: "tunnel-token" }
});
```

The credential therefore exists in neither your memory nor any command line you
wrote. Values are stored 0600 under the host's data directory, never in the
database and never in a settings row.

**A short-lived join key does not belong here at all.** Pass it once in argv
from `join` and let the vendor's daemon own the identity afterwards; store only
a credential that must survive a restart.

### Declared but not yet exercised

`supervise` and `guard` are in the contract and have no shipping consumer until
the Cloudflare Tunnel plugin lands (spec 2026-09-15, phase 3). Treat both as
specified rather than proven: the shapes are stable, the host code paths exist,
and the first real use may still turn up rough edges the three mesh plugins
never touch.

## Versioning

Declare `"apiVersion": 2` in the manifest block above. A host implementing a
lower number refuses the plugin outright, naming both versions so the operator
knows which side to upgrade. A host at a higher number lets the plugin through
that manifest gate, but that is not a compatibility window: the loader checks
members by name, so a rename across API versions refuses the older plugin at
load with a named diagnosis — a v1 plugin (the `profile` spelling) comes back
as missing `validatePreset`, never as silently working. Host members are
additive within a version line; across one, rebuild. This release is exactly
that across: rename the members and declare 2.

## Testing

`@subshell-ai/plugin-api/testing` gives you an inert host, so you do not need
Subshell itself to test a plugin:

```ts
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin from "../index.js";

const plugin = createPlugin(createTestHost());
```

## Trust

A plugin runs in the control plane's process, with that user's privileges and
no sandbox — a malicious one reaches every enrolled node, not one machine.
Installing one is the same trust decision as installing the CLI it drives,
made once for the instance. Say so honestly in your README, and prefer
manifest data over code wherever both would work.

A network plugin adds one thing to that decision rather than changing it: the
argv it returns is run on the control-plane host, and the addresses it returns
are written into the server's trusted-origin list. Both are bounded by the host
(see the rule above), and both are as trusted as the install was.

## Licence

Apache-2.0.

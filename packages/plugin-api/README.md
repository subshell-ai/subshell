# @subshell-ai/plugin-api

The contract a [Subshell](https://github.com/subshell-ai/subshell) plugin
implements.

A plugin teaches Subshell how to drive one agent CLI: how to build its launch
command, how to register the cross-subshell MCP server with it, and what its
settings are. Subshell ships six built in (Claude Code, Codex, OpenCode,
Hermes, pi, and Terminal — a plain shell that drives no agent CLI); this
package is what you build against to add another.

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
  "devDependencies": { "@subshell-ai/plugin-api": "^1.0.0" }
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

`type` (`agent-harness`, `terminal`) groups and labels your plugin in the UI.
What the launch pipeline branches on is `capabilities()`, and it is checked:
declare `resume` without a `resume` object and the host refuses to load you,
rather than letting a restart silently begin a fresh conversation.

| capability | what you must implement |
|---|---|
| `mcp` | `mcpRegistration` (a per-subshell config file) or `mcpSetup` (one-time manual steps) |
| `resume` | `resume.allocateHarnessSessionId` and the pure `resume.resumePath` |
| `attention` | `supportsAttentionHooks: true`, with the hooks wired in `buildCommand` |
| `settings` | `presetSettings()` |

## Versioning

The loader checks your plugin's members by name against this contract, so a
v1 plugin (the `profile` spelling) is diagnosed rather than silently accepted.
Declare `"apiVersion": 2` in the manifest block above; a host that implements
a lower number refuses the plugin with the version to upgrade, and a host at a
higher one keeps older plugins working — host fields are ADDED and never
removed or retyped.

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

## Licence

Apache-2.0.

import { type HarnessPluginFactory, type PluginCapability, validateGenericPreset } from "@subshell-ai/plugin-api";

/**
 * Launch OpenClaw's embedded terminal UI. `openclaw chat` is its own alias for
 * `tui --local` (2026.11.1's command list says so verbatim), and a sandboxed
 * HOME render on 2026-11-07 reached "local ready" with no Gateway running, so
 * the pane's command line is the binary, the literal `chat`, and the preset's
 * own tokens.
 *
 * **Why capabilities is empty.** Model choice lives in OpenClaw's config
 * rather than in any launch flag `chat` accepts, so there is no settings
 * surface to map. MCP is deliberately unwired: an OpenClaw MCP registration is
 * Gateway-scoped, shared by every OpenClaw session on the host, while a stdio
 * child's SUBSHELL_* credential is baked in at spawn. A registration made
 * from one pane would bind that pane's identity to every other OpenClaw
 * session on the machine, the same class of cross-pane sharing the grok-build
 * factory refuses with `--no-leader`. Launch, detect and install ship; the
 * docs page says the rest. If a per-session registration path appears, that
 * is the moment this list grows.
 *
 * `tui` and `resume` are top-level SUBCOMMANDS in 2026.11.1, not options of
 * `chat`: the flag editor stores only `-`-prefixed tokens and buildCommand
 * appends them after `chat`, so neither could ever be applied from the pane.
 * The copy-contract test pins their absence from the suggestions.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = () => ({
  // Deliberately empty, per the ruling above: the host validates this list at
  // load, so naming a capability here that the plugin does not implement
  // produces a launch that fails rather than a feature.
  capabilities: (): PluginCapability[] => [],

  buildCommand({ binary, preset, extraFlags }) {
    // `chat` is not a flag, it's the subcommand the pane's argv runs under;
    // stored tokens follow it exactly as they follow any other launch.
    return [binary, "chat", ...preset.flags, ...(extraFlags ?? [])];
  },

  validatePreset: validateGenericPreset,
  suggestedEnv: () => [
    {
      key: "OPENCLAW_CONFIG_PATH",
      description:
        "Config file path (default: ~/.openclaw/openclaw.json); keep sign-in and model config on the same one",
    },
    {
      key: "OPENCLAW_GATEWAY_TOKEN",
      description: "Gateway auth token for runs that connect to a Gateway; a local embedded chat run needs none",
    },
  ],
  suggestedFlags: () => [
    {
      flag: "--session <key>",
      description: "Open the TUI on a named session instead of the default main one",
    },
  ],
});

export default createPlugin;
export { manifest } from "./manifest.js";

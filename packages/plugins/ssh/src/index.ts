import {
  type BuildCommandInput,
  type HarnessPluginFactory,
  type PluginCapability,
  type PluginHost,
  type PresetDefinition,
  type PresetValidationResult,
  type SubshellPlugin,
  validateGenericPreset,
} from "@subshell-ai/plugin-api";

/**
 * Built-in: an interactive SSH session.
 *
 * Launch shape: the resolved ssh binary, plus the preset's option tokens.
 * The pane's command IS the ssh process, so tmux supplies the PTY and the
 * ssh env is the pane env; the connection itself is fully described by the
 * option tokens (`-F` a rendered config, `-p`, `-l`, jump flags), which is
 * why `buildCommand` is the terminal plugin's line verbatim. The pane is of
 * TYPE `terminal` for the same reason: it is a plain interactive process
 * with no agent protocol beside it.
 *
 * **Why this plugin declares a `detect` block at all.** The terminal plugin's
 * answer was indirect (a shell happens to be a binary); here it is direct:
 * `ssh` IS a binary the same way every agent harness is one, and a null
 * resolved path makes a plugin both invisible in inventories and unlaunchable
 * (`subshell-manager.service.ts` refuses to launch one). The rule travels to
 * every node as data (the `launch.ssh` rung re-resolves it against the
 * node's own machine); `SUBSHELL_SSH_PATH` is the operator's pin, the same
 * seam the tier-1 `ssh-shared.ts` ladder reads. The absolute `knownPaths` are
 * used verbatim by rung 3 of the lookup (a leading `/` is a location, not a
 * HOME-relative hint), which is where a stock OpenSSH install lives on Linux,
 * macOS and Homebrew.
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: HarnessPluginFactory = (_host: PluginHost): SubshellPlugin => ({
  // Deliberately empty. An ssh session has no MCP dialect to speak (the
  // remote shell hosts no local process that could use it), no conversation
  // to resume, no attention signal to parse and no settings to edit. The
  // host validates this list at load, so naming a capability here that the
  // plugin does not implement produces a launch that fails rather than a
  // feature.
  capabilities: (): PluginCapability[] => [],

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, preset, extraFlags } = input;
    // No name flag: ssh has no session-title notion, so the pane title is
    // whatever the remote shell sets and the reconcile sweep adopts it like
    // it adopts any terminal's.
    // Each stored flag is one complete argv token, as in every other plugin;
    // `shellQuote` at every launch site wraps them, as it does everywhere.
    return [binary, ...preset.flags, ...(extraFlags ?? [])];
  },

  validatePreset(preset: PresetDefinition): PresetValidationResult {
    return validateGenericPreset(preset);
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";

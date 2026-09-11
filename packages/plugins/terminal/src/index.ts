import {
  type BuildCommandInput,
  type PluginCapability,
  type PluginFactory,
  type PluginHost,
  type ProfileDefinition,
  type ProfileValidationResult,
  type SubshellPlugin,
  validateGenericProfile,
} from "@subshell-ai/plugin-api";

const SUGGESTED_FLAGS: { flag: string; description: string }[] = [
  { flag: "-l", description: "Start a login shell, so the full profile is sourced" },
];

/**
 * Built-in: a plain terminal.
 *
 * Launch shape: the resolved shell, bare. tmux supplies the PTY, so nothing
 * here has to arrange one.
 *
 * **Why this plugin declares a `detect` block at all.** A `terminal` plugin
 * reads like it should declare none, and `no-binary` exists for exactly that
 * case. But that reason is wired through detection and DISPLAY only: both
 * inventories report `installed: false` for a null path, and
 * `subshell-manager.service.ts` refuses to launch one. A detect-less plugin
 * would therefore be invisible and unlaunchable. A shell IS a binary, so
 * this declares `SHELL` as its override and resolves through rung 1 of the
 * ordinary ladder instead, needing no change to the launch pipeline. See
 * `docs/superpowers/specs/2026-09-10-onboarding-to-first-subshell-design.md`
 * section 3.1.
 *
 * Identity, detection and install guidance live in this package's
 * package.json `subshell` block, NOT here: the host reads them without
 * importing or executing a line of this file.
 *
 * `host` carries what this module cannot import. See `@subshell-ai/plugin-api`.
 */
const createPlugin: PluginFactory = (_host: PluginHost): SubshellPlugin => ({
  // Deliberately empty. A shell has no MCP dialect to speak, no conversation
  // to resume, no attention signal to parse and no settings to edit. The host
  // validates this list at load, so naming a capability here that the plugin
  // does not implement produces a launch that fails rather than a feature.
  capabilities: (): PluginCapability[] => [],

  buildCommand(input: BuildCommandInput): string[] {
    const { binary, profile, extraFlags } = input;
    // No `--name` equivalent: a shell has no notion of a session title to be
    // told, so the subshell's display name stays a control-plane concept and
    // the reconcile sweep never adopts a title from this pane.
    // Each stored flag is one complete argv token, as in every other plugin.
    return [binary, ...profile.flags, ...(extraFlags ?? [])];
  },

  validateProfile(profile: ProfileDefinition): ProfileValidationResult {
    return validateGenericProfile(profile);
  },

  suggestedFlags(): { flag: string; description: string }[] {
    return SUGGESTED_FLAGS;
  },
});

export default createPlugin;
export { manifest } from "./manifest.js";

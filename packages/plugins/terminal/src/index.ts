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
    // No `--name` equivalent: the launch never TELLS the shell its display
    // name, because a shell has no session-title notion. The pane's title is
    // whatever the shell itself sets (a default `.bashrc` sets `user@host:
    // dir`), and the reconcile sweep adopts such titles exactly as it does a
    // harness's — so an unnamed terminal subshell renames with the prompt
    // until the user names it, which locks it.
    // Each stored flag is one complete argv token, as in every other plugin.
    return [binary, ...profile.flags, ...(extraFlags ?? [])];
  },

  /**
   * Shells announce themselves at length. `bash --version` prints its
   * version, a copyright line, the GPL URL and a warranty disclaimer, and
   * the host uses a probe's raw output verbatim unless a plugin interprets
   * it — so without this the harness list rendered the entire licence notice
   * as the "version" (found running the first-run wizard against a real
   * host). `zsh --version` and `sh --version` are one line and survive this
   * unchanged; anything unrecognisable falls back to the first line rather
   * than to nothing, because a shell that names itself oddly is still
   * usable and its row should say something.
   */
  parseVersion(raw: string): string | null {
    const firstLine = raw
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    if (!firstLine) return null;
    const match = firstLine.match(/\d+\.\d+(?:\.\d+)?/);
    return match ? match[0] : firstLine;
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

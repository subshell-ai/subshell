import { PLUGIN_TYPES, type PluginType } from "./types.js";

/**
 * The `subshell` block of a plugin's package.json, and its parser.
 *
 * Identity lives in package.json rather than in the plugin's code so that
 * listing, displaying and gating an installed plugin reads JSON only. No
 * plugin code executes until a plugin is actually used to launch something,
 * and a node can detect that `claude` is installed before the Claude Code
 * plugin ever is.
 */

/** The contract version this package describes. Bumped only for a breaking change to `SubshellPlugin`. */
export const PLUGIN_API_VERSION = 1;

/**
 * Ids become directory names under `<dataDir>/plugins/`, so they are path
 * segments and nothing else: no separators, no traversal, no surprises from a
 * case-insensitive filesystem.
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** How a host finds this plugin's binary, as data, so a scan loads no plugin code. */
export interface DetectSpec {
  /** Executable name to look for, e.g. "claude" */
  binaryName: string;
  /** Env var that overrides the lookup outright, e.g. "CLAUDE_PATH" */
  envOverride: string;
  /** Well-known locations relative to HOME, tried after PATH */
  knownPaths: string[];
}

/** Where to send someone whose binary is missing. */
export interface InstallSpec {
  /** Copy-pasteable install command for the official installer */
  command: string;
  /** URL of the installation documentation */
  docsUrl: string;
}

/** The parsed `subshell` block. */
export interface SubshellManifest {
  /** plugin-api version this plugin was built against */
  apiVersion: number;
  /** Stable id, also its directory name */
  id: string;
  /** What kind of thing this provides */
  type: PluginType;
  /** Display name */
  name: string;
  /** One-line description shown in the UI */
  description: string;
  /** Optional emoji/glyph */
  icon?: string;
  /** Module to import, relative to the package directory */
  entry: string;
  /** Manifest-driven detection; absent for a plugin that needs no binary */
  detect?: DetectSpec;
  /** Install guidance shown when the binary is missing */
  install?: InstallSpec;
  /**
   * Environment variables this plugin computes against (spec 2026-09-10 §5).
   *
   * The node reports the VALUES of exactly these names at `ready`, so the
   * reported set grows by declaration rather than a machine shipping its
   * whole environment to the control plane. Declaring data is deliberate: a
   * WRONG name is silent, yielding an absent key and the plugin's own
   * fallback, i.e. a resume that quietly never offers itself (§11).
   */
  hostEnv?: string[];
}

/** A parse failure, carrying the sentence to render. */
export interface ManifestError {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates the `subshell` block of a plugin's package.json.
 *
 * Answers `{ error }` rather than throwing, because every caller is reporting
 * a broken plugin to a person rather than handling an exception: the node
 * marks the plugin broken and renders this message beside it. The strings are
 * therefore specific on purpose.
 * @param pkgJson - the parsed package.json of a plugin directory
 */
export function parseManifest(pkgJson: unknown): SubshellManifest | ManifestError {
  if (!isRecord(pkgJson)) return { error: "package.json is not an object" };
  const block = pkgJson.subshell;
  if (!isRecord(block)) {
    return { error: "package.json has no `subshell` block, so it is not a Subshell plugin" };
  }

  if (typeof block.apiVersion !== "number" || !Number.isInteger(block.apiVersion)) {
    return { error: "`subshell.apiVersion` must be an integer" };
  }
  if (block.apiVersion < 1) {
    // Bounded from below as well as above: `0` and negatives passed the
    // integer check and were then served as if they had said 1, which is a
    // version that never existed getting no message at all.
    return {
      error: `this plugin declares plugin-api ${block.apiVersion}, which is not a version; the lowest is 1 and this host implements ${PLUGIN_API_VERSION}`,
    };
  }
  if (block.apiVersion > PLUGIN_API_VERSION) {
    // Name BOTH numbers: the reader has to decide whether to upgrade the
    // plugin or the agent, and one number cannot tell them that.
    return {
      error: `this plugin needs plugin-api ${block.apiVersion}, but this host implements ${PLUGIN_API_VERSION}; upgrade the agent`,
    };
  }

  if (typeof block.id !== "string" || !ID_RE.test(block.id)) {
    return {
      error:
        "`subshell.id` must be lowercase letters, digits and hyphens, starting alphanumeric (it becomes a directory name)",
    };
  }
  if (typeof block.type !== "string" || !PLUGIN_TYPES.includes(block.type as PluginType)) {
    return { error: `\`subshell.type\` must be one of: ${PLUGIN_TYPES.join(", ")}` };
  }
  if (typeof block.name !== "string" || block.name.trim() === "") {
    return { error: "`subshell.name` must be a non-empty string" };
  }
  if (typeof block.description !== "string") return { error: "`subshell.description` must be a string" };
  if (block.icon !== undefined && typeof block.icon !== "string") {
    return { error: "`subshell.icon` must be a string" };
  }

  if (typeof block.entry !== "string" || block.entry.trim() === "") {
    return { error: "`subshell.entry` must be a non-empty relative path" };
  }
  // The entry is joined onto the plugin's directory and imported, so it must
  // not be able to name a file outside it. The loader re-checks the RESOLVED
  // path too; this is the cheap first gate rather than the only one.
  if (block.entry.startsWith("/") || block.entry.split("/").includes("..")) {
    return { error: "`subshell.entry` must stay inside the package (no leading `/` and no `..` segment)" };
  }

  let detect: DetectSpec | undefined;
  if (block.detect !== undefined) {
    const d = block.detect;
    if (
      !isRecord(d) ||
      typeof d.binaryName !== "string" ||
      typeof d.envOverride !== "string" ||
      !Array.isArray(d.knownPaths) ||
      !d.knownPaths.every((k) => typeof k === "string")
    ) {
      return { error: "`subshell.detect` needs binaryName, envOverride and a knownPaths array of strings" };
    }
    detect = { binaryName: d.binaryName, envOverride: d.envOverride, knownPaths: d.knownPaths as string[] };
  }

  let install: InstallSpec | undefined;
  if (block.install !== undefined) {
    const i = block.install;
    if (!isRecord(i) || typeof i.command !== "string" || typeof i.docsUrl !== "string") {
      return { error: "`subshell.install` needs a command and a docsUrl" };
    }
    install = { command: i.command, docsUrl: i.docsUrl };
  }

  // Names, not values: the package.json is checked in, the values are what
  // the node reads off its own machine at `ready`. An empty name would make
  // the node read `process.env[""]`, so it is refused here rather than
  // reported as a mystery absent key downstream.
  let hostEnv: string[] | undefined;
  if (block.hostEnv !== undefined) {
    if (!Array.isArray(block.hostEnv) || !block.hostEnv.every((k) => typeof k === "string" && k.trim() !== "")) {
      return { error: "`subshell.hostEnv` must be an array of environment variable names" };
    }
    hostEnv = [...(block.hostEnv as string[])];
  }

  return {
    apiVersion: block.apiVersion,
    id: block.id,
    type: block.type as PluginType,
    name: block.name,
    description: block.description,
    ...(typeof block.icon === "string" ? { icon: block.icon } : {}),
    entry: block.entry,
    ...(detect ? { detect } : {}),
    ...(install ? { install } : {}),
    ...(hostEnv ? { hostEnv } : {}),
  };
}

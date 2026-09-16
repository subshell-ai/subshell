import { PLUGIN_PLATFORMS, PLUGIN_TYPES, type PluginPlatform, type PluginType } from "./types.js";

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
export const PLUGIN_API_VERSION = 2;

/**
 * Image formats a plugin icon may be. The server maps these to a Content-Type
 * from a fixed table rather than sniffing the file, so this list and that
 * table are one decision: adding a format here without adding it there leaves
 * an icon that parses and then 500s when something asks for it.
 */
export const ICON_EXTENSIONS: readonly string[] = [".svg", ".png", ".webp"];

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
  /**
   * Well-known locations, tried after PATH and before the version managers.
   *
   * HOME-relative (`.local/bin/mytool`), or ABSOLUTE when the entry starts
   * with `/` — which is how a vendor's GUI install is named, since
   * `/Applications/Tailscale.app/Contents/MacOS/Tailscale` is nobody's HOME.
   * Each is a candidate to search, so an entry that does not resolve costs
   * nothing and the ladder carries on.
   */
  knownPaths: string[];
}

/** Where to send someone whose binary is missing. */
export interface InstallSpec {
  /**
   * Copy-pasteable install command for the official installer.
   *
   * A command the HOST may run on request, which is why it may not be
   * privileged: `sudo` is refused by the parser, so an installer that needs
   * root is described under {@link NetworkManifest.privileged} instead and is
   * only ever shown to copy. Without that refusal the two would be one field
   * with two meanings, and the surface offering a button would have to guess.
   */
  command: string;
  /**
   * URL of the installation documentation.
   *
   * Rendered as a link on an admin page, so it must be `http:` or `https:`
   * and the parser refuses anything else — see {@link isDocsUrl}.
   */
  docsUrl: string;
}

/** One step an operator must run themselves, because the host may not. */
export interface PrivilegedStep {
  /** What it does, in a few words: "Install the daemon" */
  label: string;
  /** The command to copy. Usually `sudo …`. */
  command: string;
  /** Where the vendor documents it; `http:`/`https:` only, as {@link isDocsUrl} requires. */
  docsUrl?: string;
  /**
   * Which ALTERNATIVE this step belongs to, and the heading it renders under.
   *
   * Steps sharing a group are one sequence to run in order; different groups
   * are different ways to arrive at the same place, and a surface renders an
   * `or` between them rather than continuing the numbering. Steps with no
   * group are one plain sequence, which is what every step was before this
   * existed.
   *
   * It exists because a platform can genuinely offer two routes: on macOS
   * Tailscale ships both a GUI app and a command-line daemon, and a page that
   * numbered those 1..3 told a person to install both. Non-empty when present
   * — it is a heading, so `""` is refused rather than coerced.
   */
  group?: string;
}

/**
 * The `subshell.network` block. Required when `type` is `network`.
 *
 * Everything here is DATA a host reads without loading plugin code: which
 * machines this plugin can run on at all, whether it can produce a login URL,
 * what publishing it exposes, and which steps only a human with root can
 * perform. A page can therefore say "not available on this platform" or print
 * the two sudo commands before any plugin code has been imported — and before
 * the vendor's CLI is anywhere on the machine.
 */
export interface NetworkManifest {
  /**
   * Operating systems this plugin can be driven on.
   *
   * Not a hint: a host refuses every act on a platform absent from this list,
   * and the UI renders the row as unavailable rather than offering a button
   * that would 409. Vendors differ here for real reasons — a CLI that talks to
   * a logged-in desktop session cannot be driven from a launchd service.
   */
  platforms: PluginPlatform[];
  /**
   * True when `join({})` with no credential can yield a URL a human finishes.
   *
   * Data rather than a capability because it describes what a RETURN VALUE may
   * be, and a capability is checked against members. The UI reads it to decide
   * whether to offer "sign in" beside "paste a key".
   */
  interactiveLogin?: boolean;
  /**
   * True when publishing leaves NOTHING the daemon can later be asked about.
   *
   * NetBird is the case that forced the field: a join is the whole publish,
   * so `status()` can only ever see the join, and a plugin that declared
   * itself `published` would claim a thing its own vendor CLI never told it.
   * The HOST's publish record is the one witness of the transition, and this
   * flag is what lets the host (and only the host) upgrade `joined` to
   * `published` from it. A plugin without the flag is never upgraded: for
   * Tailscale a serve reset outside this app is a real state, and `joined`
   * is the honest reading of it.
   */
  publishImplicit?: boolean;
  /**
   * What publishing on this network exposes the server to.
   *
   * `private` is a network only invited machines are on. `public-with-gate`
   * reaches the open internet with an identity check in front — a different
   * security posture, stated here so every surface can say so before the act
   * rather than after it.
   */
  exposure: "private" | "public-with-gate";
  /**
   * Steps the host can never perform, per platform, in the order to run them.
   *
   * Every mesh VPN installs a daemon as root and the server has no terminal to
   * answer a password prompt, so these are printed to copy and never executed.
   * Keeping them out of {@link InstallSpec} is what lets a surface offer a
   * button for one and a copy row for the other without inspecting the string.
   */
  privileged?: Partial<Record<PluginPlatform, PrivilegedStep[]>>;
  /**
   * What this network calls the two things a person acts on.
   *
   * Vendors name the same act differently and a generic word is wrong rather
   * than merely bland: Tailscale takes an "auth key", NetBird a "setup key",
   * Cloudflare a "tunnel token", and a field labelled "Auth key" on the
   * NetBird row asks for something NetBird does not have. Likewise publishing
   * is "Tailscale Serve" on one network and starting a tunnel on another.
   *
   * MANIFEST data rather than something the plugin returns, for the same
   * reason `platforms` is: a surface renders these before any plugin code has
   * been loaded, and before the vendor's CLI is anywhere on the machine. Both
   * are optional and both have a sensible generic default, so a plugin that
   * says nothing is merely plain rather than broken.
   */
  labels?: NetworkLabels;
}

/** The vendor's own words for the two acts a person takes. See {@link NetworkManifest.labels}. */
export interface NetworkLabels {
  /** What to call the pasted credential: "Auth key", "Setup key", "Tunnel token". */
  credential?: string;
  /** What to call publishing: "Publish with Tailscale Serve", "Start tunnel". */
  publish?: string;
  /**
   * Where the credential named by `credential` comes from — the vendor page
   * that mints one.
   *
   * The credential box asks for an "Auth key" on a card that otherwise says
   * nothing about what an auth key is or where to get it, and every vendor
   * words that differently enough that the SPA cannot write the sentence
   * itself. So the plugin names its page, and the card renders it as a Docs
   * link on the label row. http(s) only, refused at parse like every other
   * URL this contract carries — it lands in an `href` on an admin page.
   */
  credentialDocsUrl?: string;
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
  /**
   * Relative path to this plugin's icon file, e.g. `icon.svg`. Served by
   * the control plane at `/api/plugins/<id>/icon`; absent means the UI
   * renders a monogram instead.
   */
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
  /** Network facts. Present exactly when `type` is `network`. */
  network?: NetworkManifest;
}

/** A parse failure, carrying the sentence to render. */
export interface ManifestError {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a string may be rendered as a link in an operator's browser.
 *
 * Every `docsUrl` in this contract ends up as the `href` of an anchor on an
 * admin page, and an `href` is not inert: a `javascript:` URL in one is script
 * running on the control plane's own origin, in the session of the one person
 * who can install plugins. So a URL this contract carries is restricted to the
 * two schemes that navigate, and both the parser below and the host check it.
 *
 * It is checked in two places on purpose. A manifest is static data, so a bad
 * value there is a plugin defect and is refused at load. A URL a plugin
 * REPORTS at runtime is often something it read off a vendor CLI — Tailscale's
 * `AuthURL` comes from whichever control server the operator pointed the
 * daemon at — so the host drops that one instead, because refusing to load a
 * working plugin over a value its control server chose would be the wrong
 * failure.
 *
 * Not a reachability claim: nothing fetches these, and a docs page that 404s
 * is a broken link rather than a hazard.
 * @param value - the candidate URL, as written in a manifest or returned by a plugin
 */
export function isDocsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not absolute, or not a URL at all. A relative href would resolve
    // against the SPA's own origin, which is never what a vendor docs link
    // means.
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
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
  if (block.icon !== undefined) {
    if (typeof block.icon !== "string" || block.icon.trim() === "") {
      return { error: "`subshell.icon` must be a non-empty relative path to an image in the package" };
    }
    // Same containment rule as `entry`, for the same reason: this path is
    // joined onto the plugin's directory and the file is READ and SERVED, so
    // it must not be able to name one outside it.
    if (block.icon.startsWith("/") || block.icon.split("/").includes("..")) {
      return { error: "`subshell.icon` must stay inside the package (no leading `/` and no `..` segment)" };
    }
    // The extension is the whole basis for the Content-Type the icon is
    // served with - the server maps it from a fixed table and never sniffs
    // the bytes, because a type inferred from plugin-supplied content is a
    // type the plugin chose. An extension outside the table has no safe
    // answer, so it is refused here rather than guessed at there.
    const icon = block.icon;
    if (!ICON_EXTENSIONS.some((ext) => icon.endsWith(ext))) {
      return { error: `\`subshell.icon\` must end in one of: ${ICON_EXTENSIONS.join(", ")}` };
    }
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
    // The one field a host will RUN on request, so it may not need root: the
    // server has no terminal to answer a password prompt, and a surface
    // offering a button must be able to tell from the manifest alone that
    // pressing it can work. Privileged steps have their own field.
    if (/^\s*sudo(\s|$)/.test(i.command)) {
      return {
        error:
          "`subshell.install.command` must not need sudo — the host runs it and has no terminal for a password prompt; put privileged steps in `subshell.network.privileged`",
      };
    }
    // Rendered as a link beside that button, so it is held to the same rule
    // as every other URL this manifest carries.
    if (!isDocsUrl(i.docsUrl)) {
      return { error: "`subshell.install.docsUrl` must be an http(s) URL — it is rendered as a link on an admin page" };
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

  const type = block.type as PluginType;
  const parsedNetwork = parseNetworkBlock(block.network, type);
  if (parsedNetwork !== undefined && "error" in parsedNetwork) return parsedNetwork;

  return {
    apiVersion: block.apiVersion,
    id: block.id,
    type,
    name: block.name,
    description: block.description,
    ...(typeof block.icon === "string" ? { icon: block.icon } : {}),
    entry: block.entry,
    ...(detect ? { detect } : {}),
    ...(install ? { install } : {}),
    ...(hostEnv ? { hostEnv } : {}),
    ...(parsedNetwork ? { network: parsedNetwork } : {}),
  };
}

/**
 * Parses `subshell.network`, which is required for and exclusive to `network`.
 *
 * Both directions are refused rather than tolerated. A network plugin without
 * the block would be unrenderable — nothing could say which platforms it runs
 * on or what publishing it exposes, and the safe default for "what does this
 * expose" is not a default anyone should pick silently. A harness WITH one
 * declares facts nothing reads, which is how a manifest starts lying.
 * @returns the parsed block, an error, or undefined when there is none to have
 */
function parseNetworkBlock(raw: unknown, type: PluginType): NetworkManifest | ManifestError | undefined {
  if (type !== "network") {
    if (raw !== undefined) {
      return { error: `\`subshell.network\` is only for \`type: "network"\` plugins, and this one is \`${type}\`` };
    }
    return undefined;
  }
  if (!isRecord(raw)) {
    return { error: '`subshell.network` is required for `type: "network"` plugins' };
  }

  if (
    !Array.isArray(raw.platforms) ||
    raw.platforms.length === 0 ||
    !raw.platforms.every((p) => typeof p === "string" && PLUGIN_PLATFORMS.includes(p as PluginPlatform))
  ) {
    return { error: `\`subshell.network.platforms\` must be a non-empty array of: ${PLUGIN_PLATFORMS.join(", ")}` };
  }

  if (raw.exposure !== "private" && raw.exposure !== "public-with-gate") {
    return { error: '`subshell.network.exposure` must be "private" or "public-with-gate"' };
  }

  if (raw.interactiveLogin !== undefined && typeof raw.interactiveLogin !== "boolean") {
    return { error: "`subshell.network.interactiveLogin` must be a boolean" };
  }
  if (raw.publishImplicit !== undefined && typeof raw.publishImplicit !== "boolean") {
    return { error: "`subshell.network.publishImplicit` must be a boolean" };
  }

  let privileged: Partial<Record<PluginPlatform, PrivilegedStep[]>> | undefined;
  if (raw.privileged !== undefined) {
    if (!isRecord(raw.privileged)) {
      return { error: "`subshell.network.privileged` must be an object keyed by platform" };
    }
    privileged = {};
    for (const [platform, steps] of Object.entries(raw.privileged)) {
      if (!PLUGIN_PLATFORMS.includes(platform as PluginPlatform)) {
        return { error: `\`subshell.network.privileged\` has an unknown platform "${platform}"` };
      }
      if (
        !Array.isArray(steps) ||
        !steps.every(
          (s) =>
            isRecord(s) &&
            typeof s.label === "string" &&
            s.label.trim() !== "" &&
            typeof s.command === "string" &&
            s.command.trim() !== "" &&
            (s.docsUrl === undefined || typeof s.docsUrl === "string") &&
            (s.group === undefined || typeof s.group === "string"),
        )
      ) {
        return {
          error: `\`subshell.network.privileged.${platform}\` must be an array of { label, command, docsUrl?, group? }`,
        };
      }
      // Refused rather than coerced, for the same reason an empty label is: a
      // group is a HEADING, and one with no words renders as a gap above a
      // sequence that then reads as a continuation of the group before it.
      const badGroup = (steps as PrivilegedStep[]).find((s) => s.group !== undefined && s.group.trim() === "");
      if (badGroup) {
        return {
          error: `\`subshell.network.privileged.${platform}\` has an empty \`group\`, which is a heading with no words: "${badGroup.label}"`,
        };
      }
      const badDocs = (steps as PrivilegedStep[]).find((s) => s.docsUrl !== undefined && !isDocsUrl(s.docsUrl));
      if (badDocs) {
        return {
          error: `\`subshell.network.privileged.${platform}\` has a docsUrl that is not an http(s) URL: "${badDocs.label}"`,
        };
      }
      privileged[platform as PluginPlatform] = (steps as PrivilegedStep[]).map((s) => ({
        label: s.label,
        command: s.command,
        ...(s.docsUrl ? { docsUrl: s.docsUrl } : {}),
        ...(s.group ? { group: s.group } : {}),
      }));
    }
  }

  let labels: NetworkLabels | undefined;
  if (raw.labels !== undefined) {
    if (!isRecord(raw.labels)) return { error: "`subshell.network.labels` must be an object" };
    for (const key of ["credential", "publish"]) {
      const value = raw.labels[key];
      // Refused rather than coerced: an empty label renders as a control with
      // no name, which is worse than the generic default it replaced.
      if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
        return { error: `\`subshell.network.labels.${key}\` must be a non-empty string` };
      }
    }
    const credDocs = raw.labels.credentialDocsUrl;
    // Refused, not dropped: the other URL fields are too. A manifest is
    // static data, so a non-http(s) value here is a plugin defect and the
    // operator should hear about it at load rather than meet a quietly
    // absent link — or, without the refusal, a `javascript:` href.
    if (credDocs !== undefined && (typeof credDocs !== "string" || !isDocsUrl(credDocs))) {
      return {
        error:
          "`subshell.network.labels.credentialDocsUrl` must be an http(s) URL — it is rendered as a link on an admin page",
      };
    }
    labels = {
      ...(typeof raw.labels.credential === "string" ? { credential: raw.labels.credential } : {}),
      ...(typeof raw.labels.publish === "string" ? { publish: raw.labels.publish } : {}),
      ...(typeof raw.labels.credentialDocsUrl === "string" ? { credentialDocsUrl: raw.labels.credentialDocsUrl } : {}),
    };
  }

  return {
    platforms: [...(raw.platforms as PluginPlatform[])],
    exposure: raw.exposure,
    ...(raw.interactiveLogin === true ? { interactiveLogin: true } : {}),
    ...(raw.publishImplicit === true ? { publishImplicit: true } : {}),
    ...(privileged ? { privileged } : {}),
    ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
  };
}

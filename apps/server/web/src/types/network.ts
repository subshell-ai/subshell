/**
 * Hand-written mirror of `GET /api/network` — the network plugins that connect
 * this control plane to a private network (Tailscale first; Headscale, NetBird
 * and Cloudflare Tunnel behind the same shape).
 *
 * Every route behind these types is **admin cookie only**, the read included:
 * joining a network and publishing this server on it are acts on the machine,
 * and the status carries login URLs and identity a member has no business
 * reading. The page gates itself on `viewerIsAdmin` for that reason, exactly
 * as `/settings/service` does.
 */

/**
 * Where one network stands on this host, in the order a person walks it.
 *
 * The first three are all "this machine is not ready", and they are kept
 * apart because the remedy differs: nothing is installed, the daemon is
 * installed but not running, or it is running and this process may not talk
 * to it. Collapsing them would leave one sentence that is wrong two times
 * out of three.
 */
export type NetworkState = "not-installed" | "daemon-down" | "needs-privilege" | "needs-login" | "joined" | "published";

/** One address this server can be reached at over the network. */
export interface NetworkAddress {
  /** The full URL, as a person would type it */
  url: string;
  /** Scheme, kept beside the URL so a reader never has to parse it */
  scheme: "https" | "http";
  /** What this address IS — "MagicDNS name", "Tailscale IP", … */
  label: string;
  /**
   * Whether a browser at this URL is in a secure context.
   *
   * The one fact that decides whether passkeys and secure cookies work, and
   * it is NOT derivable from "the network encrypts this": a plain-http
   * address over an encrypted tunnel is private on the wire and still a
   * non-secure context to the browser, which is where WebAuthn is refused.
   */
  secureContext: boolean;
}

/** Something to do about the state, as the plugin words it. */
export interface NetworkHint {
  /** The sentence, rendered verbatim — the plugin owns this copy, not the SPA */
  text: string;
  /** A command to run ON this host, shown copyable */
  command?: string;
  /** Where the vendor documents it */
  docsUrl?: string;
  /** True when the command needs root; the server will not run it, so it is copy-only */
  privileged?: boolean;
}

/** One network's answer about this host. */
export interface NetworkStatus {
  /** Where it stands */
  state: NetworkState;
  /** Addresses this server is reachable at, empty until it has joined */
  addresses: NetworkAddress[];
  /** Where to finish an interactive sign-in, present while `needs-login` */
  loginUrl?: string;
  /** A short code the sign-in page asks for, when the vendor uses one */
  loginCode?: string;
  /** What the network calls itself and this machine, once it knows */
  identity?: { network?: string; hostname?: string; version?: string };
  /** What to do next, in order; rendered verbatim */
  hints: NetworkHint[];
}

/** One editable plugin setting, as the plugin declares it. */
export interface SettingsFieldWire {
  /** Key into the settings object */
  key: string;
  /** Field label */
  label: string;
  /** One-line help, rendered under the control */
  description?: string;
  /**
   * Editor control kind. `secret` is not a string: its value never comes back
   * from the server, so the form shows whether one is SET and offers to
   * replace it.
   */
  type: "string" | "boolean" | "number" | "select" | "secret";
  /** Choices when `type` is `select` */
  choices?: string[];
  /** Whether the plugin refuses to work without it */
  required?: boolean;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Value used when unset */
  default?: string | boolean | number;
}

/** The daemon this plugin supervises, when it supervises one. */
export interface SupervisorStateWire {
  /** Whether the process is up right now */
  running: boolean;
  /** Its pid while running */
  pid?: number;
  /** ISO 8601 stamp of when the current run started */
  since?: string;
  /** How many times it has been respawned */
  restarts: number;
  /** How the last run ended, when one has ended */
  lastExit?: { code: number | null; at: string };
  /** The process's own most recent output lines, newest last */
  lastLines: string[];
}

/**
 * The value a setting currently holds. A secret never travels: the server
 * sends `{ set: true|false }` in its place, which is everything the form may
 * know about it.
 */
export type NetworkSettingValue = string | { set: boolean };

/** One network plugin, as `GET /api/network` lists it. */
export interface NetworkRow {
  /** Plugin id — the path segment every write below uses */
  id: string;
  /** Display name */
  name: string;
  /** One-line description */
  description: string;
  /**
   * The manifest's icon PATH, relative to the plugin package — not an emoji.
   * The server serves the file at `/api/plugins/:id/icon`, which is what
   * `PluginIcon` fetches by id, so nothing in this app reads this field. It
   * stays because the wire carries it and a mirror that omitted it would look
   * like a field this page had decided to drop.
   */
  icon?: string;
  /**
   * What publishing here exposes.
   *
   * `private` keeps this server on a network only the operator's own devices
   * are on. `public-with-gate` puts it on the public internet behind an
   * identity check, which is a different decision and is called out on the
   * card rather than left to the plugin's description.
   */
  exposure: "private" | "public-with-gate";
  /** Platforms this plugin can drive */
  platforms: ("darwin" | "linux")[];
  /** Whether THIS host's platform is one of them */
  supported: boolean;
  /** Whether the instance offers this plugin (`plugin_state`) */
  enabled: boolean;
  /** Whether signing in means visiting a URL the vendor mints */
  interactiveLogin: boolean;
  /**
   * Whether the network routes addresses to this machine by membership alone.
   *
   * The two kinds of published are NOT the same act to undo, and the row is
   * where the card learns which it is offering. NetBird is `true`: its publish
   * left nothing the daemon can be re-asked about, so unpublishing removes the
   * host's record while the machine's addresses keep answering for as long as
   * it stays a member. The serve/tunnel plugins are `false`: there the record
   * names the mechanism (serve reset, tunnel stop) and the published addresses
   * really do go down. A confirmation that promised a shutdown on the first
   * kind would be describing an act that does not happen.
   */
  publishImplicit: boolean;
  /** An install command the SERVER may run, absent where it may not */
  install?: { command: string; docsUrl: string };
  /**
   * Steps needing root ON THIS PLATFORM — copy-only, never run from here.
   *
   * `group` marks which ALTERNATIVE a step belongs to: steps sharing one are a
   * sequence, different groups are ways to arrive at the same place and the
   * card renders an `or` between them. Absent on every step of every plugin
   * that offers one route, which is what keeps those rows a plain numbered
   * list.
   */
  privileged: { label: string; command: string; docsUrl?: string; group?: string }[];
  /**
   * The vendor's own words for the acts, and the page behind the credential,
   * from the manifest.
   *
   * Either word may be absent, and the card supplies a generic default — but
   * a generic word is WRONG rather than bland for the credential: Tailscale
   * takes an auth key, NetBird a setup key, Cloudflare a tunnel token, and a
   * field labelled "Auth key" on a NetBird row asks for something NetBird does
   * not have. `credentialDocsUrl` is where one of those is minted — the box
   * says what to paste, the Docs link says where to get it — and absent means
   * no link is rendered.
   */
  labels: { credential?: string; publish?: string; credentialDocsUrl?: string };
  /** The plugin's settings schema; empty means the card shows no form */
  settingsFields: SettingsFieldWire[];
  /** Current values, secrets as `{ set }` */
  settings: Record<string, NetworkSettingValue>;
  /** This host's status — absent when the plugin is unsupported or disabled */
  status?: NetworkStatus;
  /** The daemon this plugin runs, when it runs one */
  process?: SupervisorStateWire;
  /** Whether this server is currently published on this network */
  published: boolean;
}

/** `GET /api/network`. */
export interface NetworkList {
  /** One row per network plugin the instance holds, id-sorted */
  networks: NetworkRow[];
}

/** What a `join` stream settled on. */
export type JoinOutcome = { state: "joined" } | { state: "needs-login"; loginUrl: string; loginCode?: string };

/** The `done` frame of `POST /api/network/:id/join`. */
export interface NetworkJoinResult {
  /** Joined outright, or waiting on the person to finish signing in */
  outcome: JoinOutcome;
  /**
   * The status as of the end of the stream. For a `publishImplicit`
   * network the join IS the publish and this status says so (`state:
   * "published"`, addresses filled) — the server trusts those addresses
   * from this moment. No config write and no restart flag ride the frame:
   * the allowlist is a live registry (2026-09-16).
   */
  status: NetworkStatus;
}

/**
 * The `POST /api/network/:id/leave` result: the machine is off the network,
 * and `origins` names the addresses that stopped accepting sign-ins with it
 * — as of this answer, not a restart. Leave is NetBird's normal path off the
 * allowlist (a joined implicit row shows no Unpublish button), and its
 * `origins` is the full snapshot of what the WHOLE act ended, taken at request
 * start — a gated network's trust dies at the inner unpublish step, but this
 * act is what ends it (ruling R-D-lite v2).
 */
export interface NetworkLeaveResult {
  ok: true;
  /** Everything this act ended, as the request-start snapshot — a gated network's trust died at the inner unpublish step and is still listed; empty when nothing was trusted */
  origins: string[];
  /** The status as of the end of the act */
  status: NetworkStatus;
}

/**
 * The `POST /api/network/:id/unpublish` result. `origins` is the DIFF — the
 * origins that actually stopped being trusted as of this answer, the
 * registry following the record live (ruling R-D-lite). A private network
 * keeps trusting its addresses while this host stays a member, so an
 * unpublish there is normally empty; the audit row and the record still name
 * what the publish had held. No kind is exempt from following the record,
 * `publishImplicit` included.
 */
export interface NetworkUnpublishResult {
  ok: true;
  /** Origins that stopped being trusted as of this answer; normally empty for a private network */
  origins: string[];
  /** The status as of the end of the act */
  status: NetworkStatus;
}

/** The `done` frame of `POST /api/network/:id/publish`. */
export interface NetworkPublishResult {
  /** Whether this server is now published */
  ok: boolean;
  /** Why not, when `ok` is false — an ANSWER, not an error */
  refused?: NetworkHint;
  /** Where it is reachable — and accepted for sign-in — now */
  addresses: NetworkAddress[];
  /** The status as of the end of the stream */
  status: NetworkStatus;
}

/**
 * The `done` frame of `POST /api/network/:id/install`.
 *
 * Same shape as the tmux and agent installers, because it is the same act: a
 * command this server runs on its own host, reporting its own output. The
 * fields after `ok` are optional so a row whose installer reports less than a
 * package manager does still settles cleanly — the row's own status refetch
 * is what says whether the network arrived.
 */
export interface NetworkInstallResult {
  /** Whether the installer exited zero */
  ok: boolean;
  /** Its exit code, or null when it could not be run */
  exitCode?: number | null;
  /** Captured stdout+stderr */
  output?: string;
  /** The status after the attempt, when the server re-probed */
  status?: NetworkStatus;
}

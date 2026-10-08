import {
  parseSshConnectionSnapshot,
  SSH_PATH_MAX_CHARS,
  type SshConnectionSnapshotWire,
  type SshHopWire,
} from "@internal/subshell-protocol";

/**
 * The runtime renderer: an approved snapshot in, option argv + own config file
 * out (docs/superpowers/specs/2026-10-07-ssh-anywhere-design.md §5.2: render a
 * per-connection config from the resulting snapshot; the built `ssh` runs
 * against the rendered snapshot config via `-F` only, never the connecting
 * machine's live `~/.ssh/config`).
 *
 * Two artifacts, one policy:
 *
 * - **The config file** (`renderSshConfigContents`) carries the mandatory
 *   policy under `Host *`. This is NOT belt-and-suspenders over the command
 *   line: ssh spawns ProxyJump children (`ssh -W …`) that do NOT inherit the
 *   parent's `-o` options, and the jump child re-reads the `-F` file. A
 *   policy written only on the command line would restrict the last hop and
 *   nothing above it. The `Host *` shape is what makes the policy
 *   EVERY-HOP.
 * - **The argv** (`sshOptionTokens` + `sshDestinationToken`) carries only the
 *   DESTINATION-scoped facts (`-F`, port, user, HostKeyAlias, ProxyJump chain)
 *   — options the jump children must NOT inherit — plus `-F` so the user
 *   config the whole chain reads is ours.
 *
 * Config keyword precedence is the second reason this split works: within one
 * ssh invocation the command line wins over the user file, which wins over
 * the system file, PER KEYWORD (first-obtained wins). Every key the policy
 * names appears in our file, so `/etc/ssh/ssh_config` cannot reintroduce a
 * forwarding directive, a control socket, or canonicalization for this
 * connection's hops. Keywords the policy does not name and a system file
 * could set remain root's to decide — inside the OS trust boundary, per
 * docs/security.md §0-1, and resolution already ran `-G` WITH that system
 * file, so what it refused, the snapshot never carries.
 *
 * The snapshot is re-validated on entry: the renderer's refusal set is
 * "anything the grammar cannot express", and the grammar is the protocol's,
 * so renderer and wire can never disagree about what is renderable.
 */

/**
 * Refuse to render anything the frozen grammar rejects (a hand-built object
 * never reaches the child). The check IS `parseSshConnectionSnapshot`: the
 * same rebuild the wire performs, so renderer and contract can never
 * disagree about what is renderable, and grammar growth on the protocol side
 * lands here automatically. The option-like leading dashes ride on top: the
 * grammar's own doc names them ssh-argv material, and the renderer is the
 * last station before argv.
 */
function assertRenderable(snapshot: SshConnectionSnapshotWire): void {
  if (parseSshConnectionSnapshot(snapshot) === null) throw new Error("snapshot not renderable");
  if (snapshot.host.startsWith("-") || snapshot.proxyJumps.some((h) => h.host.startsWith("-"))) {
    throw new Error("snapshot not renderable");
  }
}

/**
 * The mandatory every-hop policy, as `Host *` lines. This is the M1
 * interactive-terminal policy (spec 2026-10-07 §5.2/§9): every hop stays
 * confined (forwarding, control sockets, local commands, the escape menu all
 * die here because ssh spawns ProxyJump children that re-read THIS file),
 * while the session itself stays a terminal: auth methods are the server's to
 * offer and a changed host key is OpenSSH's own hard block. Each entry is
 * that sentence made concrete; the comments name which.
 */
const MANDATORY_POLICY: readonly [string, string][] = [
  // first connect records the key in the machine's own known_hosts; a CHANGED
  // key is refused by OpenSSH itself (spec 2026-10-07 §9: accept-new is the M1 posture)
  ["StrictHostKeyChecking", "accept-new"],
  // no agent or X11 forwarding (spec 2026-10-07 §5.2: forwards refused by name, never reappearing)
  ["ForwardAgent", "no"],
  ["ForwardX11", "no"],
  ["ForwardX11Trusted", "no"],
  // no local/remote/dynamic forwards or tunnels, whatever any config said
  ["ClearAllForwardings", "yes"],
  ["Tunnel", "no"],
  ["PermitRemoteOpen", "none"],
  // no local commands on any branch (spec 2026-10-07 §5.2: remote/local commands refused by name)
  ["PermitLocalCommand", "no"],
  // the command contract owns the remote side; no imported remote command / env (spec 2026-10-07 §5.2: env and command sends refused)
  ["RemoteCommand", "none"],
  // no escape menu; `~` is a local shell (spec 2026-10-07 §5.2: escape sends refused)
  ["EscapeChar", "none"],
  // no ambient control sockets or multiplexing (spec 2026-10-07 §5.2: the render carries only approved facts)
  ["ControlMaster", "no"],
  ["ControlPath", "none"],
  ["GSSAPIAuthentication", "no"],
  // trust is host-key trust only: DNS- and fetch-based checks are not
  // host-key trust, and canonicalization could send the connection to a host
  // the reviewer never approved
  ["VerifyHostKeyDNS", "no"],
  ["CanonicalizeHostname", "no"],
];

/** A destination or hop as ssh argv syntax: `user@host`, `host:port`, brackets for IPv6 kept. */
function hopToken(hop: SshHopWire): string {
  const who = hop.user !== null ? `${hop.user}@` : "";
  const port = hop.port !== 22 ? `:${hop.port}` : "";
  return `${who}${hop.host}${port}`;
}

/**
 * A file-valued ssh_config token as OpenSSH's own tokenizer accepts it: the
 * config parser splits values on WHITESPACE (control chars are already
 * refused by the snapshot grammar), so an absolute path carrying a space —
 * legal POSIX, legal `isAbsPosixPath` — would otherwise misparse into two
 * tokens (a truncated identity file plus garbage). Double quotes with
 * backslash escapes are the quoting OpenSSH's strdelim honors for
 * file-valued keywords; the escape is applied before the wrap so the value
 * is byte-exact after the parser's unquote. Plain paths stay unquoted: the
 * rendering is byte-stable for a given snapshot, and quoting every path
 * would churn bytes for no gain.
 */
function configPathValue(path: string): string {
  if (!/[\s"\\]/.test(path)) return path;
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** One config line for each known-hosts ref the snapshot names; absent names render nothing. */
function knownHostsLines(files: string[]): string[] {
  // absent renders nothing: ssh's own default `~/.ssh/known_hosts` is the M1
  // trust store (spec 2026-10-07 §9) - the tier's product wrote /dev/null because its
  // BatchMode posture made silence fail closed; here silence IS the policy.
  if (files.length === 0) return [];
  return files.map((f) => `    UserKnownHostsFile ${configPathValue(f)}`);
}

/**
 * Render the runtime ssh_config FILE for one snapshot: the policy above,
 * every hop included, plus the snapshot's trust refs and identity refs under
 * the same `Host *` so jump children authenticate from the same approved
 * material (`SshHopWire`'s doc: "authentication for the whole chain comes
 * from the snapshot's own refs"). Contents are deterministic in the snapshot
 * — the same approval always renders the same file, which is what makes the
 * run's recorded config byte-checkable.
 */
export function renderSshConfigContents(snapshot: SshConnectionSnapshotWire): string {
  assertRenderable(snapshot);
  const lines = [
    "# Subshell managed SSH config - GENERATED, do not edit.",
    "# Mandatory runtime policy for the connection and every ProxyJump hop (spec 2026-10-07 §5.2).",
    "Host *",
    ...MANDATORY_POLICY.map(([key, value]) => `    ${key} ${value}`),
    ...knownHostsLines(snapshot.knownHostsFiles),
    ...snapshot.identityFiles.map((f) => `    IdentityFile ${configPathValue(f)}`),
    ...snapshot.certificateFiles.map((f) => `    CertificateFile ${configPathValue(f)}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Build ssh's option argv for one snapshot: EVERYTHING after the binary
 * EXCEPT the trailing `-- host` tail ({@link sshDestinationToken} carries
 * that one entry). `-F <path>` first (the caller composed the path with
 * {@link buildSshConfigPath} and owns the write), then `-p` ALWAYS (the
 * port is a resolved fact, never ssh's guess), `-l` only when the snapshot
 * names a user, and `HostKeyAlias`/`ProxyJump` only when set. No `-tt`: this
 * pane allocates its PTY through tmux and carries no remote command, so
 * OpenSSH auto-requests the remote tty.
 *
 * EVERY element is a string this function composed from snapshot-scoped
 * values; the destination never comes from a config string, never from `~`,
 * never from PATH (the binary itself is an absolute argv[0] the caller
 * resolved). Option-like destinations are impossible by grammar (the snapshot
 * validator refuses a leading `-`) plus re-checked here
 * ({@link assertRenderable}); the `--` terminator is the last word to getopt
 * anyway. Policy options deliberately DO NOT ride here: they live in the
 * `-F` file the jump children re-read.
 */
export function sshOptionTokens(snapshot: SshConnectionSnapshotWire, configPath: string): string[] {
  assertRenderable(snapshot);
  if (configPath.length === 0 || !configPath.startsWith("/") || configPath.length > SSH_PATH_MAX_CHARS) {
    throw new Error("config path must be absolute POSIX");
  }
  const argv = ["-F", configPath];
  argv.push("-p", String(snapshot.port));
  if (snapshot.user !== null) argv.push("-l", snapshot.user);
  if (snapshot.hostKeyAlias !== null) argv.push("-o", `HostKeyAlias=${snapshot.hostKeyAlias}`);
  if (snapshot.proxyJumps.length > 0) {
    argv.push("-o", `ProxyJump=${snapshot.proxyJumps.map(hopToken).join(",")}`);
  }
  return argv;
}

/**
 * The destination as the single argv entry that follows the `--` terminator:
 * ssh's bare host, never a `user@`/`:port` decoration (user and port ride as
 * their own option tokens). Refuses the same way {@link sshOptionTokens}
 * does: the two halves of the argv share one renderability verdict.
 */
export function sshDestinationToken(snapshot: SshConnectionSnapshotWire): string {
  assertRenderable(snapshot);
  return snapshot.host;
}

/**
 * The derived per-pane config path is composed here so plane and node agree
 * byte-for-byte from the two facts each already holds (dataDir, subshellId).
 * The path DOES ride the launch frame (the ssh member's `configPath`), but
 * as a CLAIM the receiving end never trusts: the agent's `commands/launch.ts`
 * re-derives it from its own dataDir and the pane id and refuses a
 * byte-mismatch (the LocalLauncher runs the same check in-process), so a
 * hostile plane naming any path still cannot point the config write outside
 * this machine's derivation. The refusals are impossible-state guards at
 * composition sites (matching the codebase's path-composition doctrine): a
 * relative dataDir or an id outside `/^[a-zA-Z0-9_-]{1,64}$/` THROWS rather
 * than composing a path that escapes the directory.
 */
export function buildSshConfigPath(dataDir: string, subshellId: string): string {
  if (!dataDir.startsWith("/")) throw new Error("ssh config path: dataDir must be absolute POSIX");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(subshellId)) throw new Error("ssh config path: invalid subshellId");
  return `${dataDir}/ssh/${subshellId}/config`;
}

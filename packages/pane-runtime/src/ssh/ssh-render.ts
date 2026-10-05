import {
  parseSshConnectionSnapshot,
  SSH_PATH_MAX_CHARS,
  type SshConnectionSnapshotWire,
  type SshHopWire,
} from "@internal/subshell-protocol";
import { shellQuote } from "../shell.js";
import { sshChildPath } from "./ssh-spawn.js";

/**
 * The runtime renderer: an approved snapshot in, argv + own config file out
 * (SSH-SUPPORT.md §2: "Render runtime config from an explicit allowlist; do
 * not let runtime SSH reread ambient user/system configuration").
 *
 * Two artifacts, one policy:
 *
 * - **The config file** (`renderSshConfigContents`) carries the mandatory
 *   policy under `Host *`. This is NOT belt-and-suspenders over the command
 *   line: ssh spawns ProxyJump children (`ssh -W …`) that do NOT inherit the
 *   parent's `-o` options, and the jump child re-reads the `-F` file. A
 *   policy written only on the command line would restrict the last hop and
 *   nothing above it. The `Host *` shape is what makes the policy
 *   EVERY-HOP, which is exactly what §2 demands.
 * - **The argv** (`buildSshInvocation`) carries only the DESTINATION-scoped
 *   facts (port, user, HostKeyAlias, ProxyJump chain) — options the jump
 *   children must NOT inherit — plus `-F` so the user config the whole chain
 *   reads is ours.
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
 * The mandatory every-hop policy, as `Host *` lines. Each entry is the §2
 * runtime-policy sentence made concrete; the comments name which.
 */
const MANDATORY_POLICY: readonly [string, string][] = [
  // noninteractive auth only: no password/MFA prompt can stall a supervised run
  ["BatchMode", "yes"],
  // require existing verified host trust; unknown/changed/revoked fail closed
  ["StrictHostKeyChecking", "yes"],
  // no agent or X11 forwarding (the §2 "no agent/X11 forwarding" sentence)
  ["ForwardAgent", "no"],
  ["ForwardX11", "no"],
  ["ForwardX11Trusted", "no"],
  // no local/remote/dynamic forwards or tunnels, whatever any config said
  ["ClearAllForwardings", "yes"],
  ["Tunnel", "no"],
  ["PermitRemoteOpen", "none"],
  // no local commands on any branch (§2 "no local commands")
  ["PermitLocalCommand", "no"],
  // the command contract owns the remote side; no imported remote command / env (§2 "Do not import RemoteCommand, SendEnv, SetEnv")
  ["RemoteCommand", "none"],
  // no escape menu — `~` is a local shell (§2 "no SSH escape commands")
  ["EscapeChar", "none"],
  // no ambient control sockets or multiplexing (§2's explicit clause)
  ["ControlMaster", "no"],
  ["ControlPath", "none"],
  // auth is key/certificate only (§2 "Require key-based authentication in v1")
  ["PasswordAuthentication", "no"],
  ["KbdInteractiveAuthentication", "no"],
  ["HostbasedAuthentication", "no"],
  // GSSAPIAuthentication is the canonical spelling; the legacy
  // `KerberosAuthentication` alias it subsumed is REMOVED from recent OpenSSH
  // (measured: 10.2p1 warns `Unsupported option "kerberosauthentication"` on
  // EVERY launch, e2e fixture log). The warning was noise, never a refusal,
  // but a policy line the client can no longer parse disables nothing: the
  // GSSAPI line above is what actually kills that auth path.
  ["GSSAPIAuthentication", "no"],
  // trust comes ONLY from the pinned files below: DNS- and fetch-based checks
  // are not "existing verified host trust", and canonicalization could send
  // the connection to a host the reviewer never approved
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
 * rendered file is byte-stable in the snapshot (a dedup record's config is
 * re-read by digest), and quoting every path would churn bytes for no gain.
 */
function configPathValue(path: string): string {
  if (!/[\s"\\]/.test(path)) return path;
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** One config line for each known-hosts ref, or the fail-closed /dev/null stand-in when the snapshot names none. */
function knownHostsLines(files: string[]): string[] {
  if (files.length === 0) return ["    UserKnownHostsFile /dev/null"];
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
    "# Mandatory runtime policy for the connection and every ProxyJump hop (§2).",
    "Host *",
    ...MANDATORY_POLICY.map(([key, value]) => `    ${key} ${value}`),
    ...knownHostsLines(snapshot.knownHostsFiles),
    ...snapshot.identityFiles.map((f) => `    IdentityFile ${configPathValue(f)}`),
    ...snapshot.certificateFiles.map((f) => `    CertificateFile ${configPathValue(f)}`),
    "",
  ];
  return lines.join("\n");
}

/** Inputs to {@link buildSshInvocation}. */
export interface SshInvocationInput {
  /** Absolute path of the ssh binary (the ladder resolved it; this never searches). */
  sshBin: string;
  snapshot: SshConnectionSnapshotWire;
  /** Absolute path the rendered config file was written to (the caller owns the write; the renderer owns the `-F` clause). */
  configPath: string;
  /**
   * The remote command line, as the single argv string ssh will hand the
   * remote shell (`remoteCommandLine` builds the cd-prefixed form). Absent =
   * no command: an interactive session under the pane's PTY.
   */
  remoteCommand?: string;
  /**
   * Force a remote PTY (`-tt`). Structured runs pass nothing (their contract
   * is a pipe, no TTY). Managed TERMINAL panes pass `true` ALWAYS, with or
   * without a remote command: OpenSSH only auto-requests a tty when ssh
   * carries no command at all, and the terminal launch's cd + login-shell
   * line IS a command — without `-tt` that session would run with no remote
   * PTY at all (no line editing, no programs that require a tty). The
   * destination pane's own PTY is necessary but not sufficient; the remote
   * one is what `ssh` must be told to allocate (coordinator ruling, fix
   * round 1: uniform `-tt` for every terminal launch).
   */
  forceTty?: boolean;
}

/**
 * Build ssh's argv for one snapshot. EVERY element is a string this function
 * composed from snapshot-scoped values; the destination never comes from a
 * config string, never from `~`, never from PATH (the binary itself is an
 * absolute argv[0] the caller resolved). Option-like destinations are
 * impossible by grammar (the snapshot validator refuses a leading `-`) plus
 * re-checked here ({@link assertRenderable}); the `--` terminator is the last
 * word to getopt anyway.
 *
 * @returns the complete argv, `--` separated from options, remote command as
 *   ONE trailing element when there is one (a multi-word command must not
 *   become N argv strings ssh would re-join with its own spacing).
 */
export function buildSshInvocation(input: SshInvocationInput): string[] {
  assertRenderable(input.snapshot);
  const { snapshot } = input;
  if (
    input.configPath.length === 0 ||
    !input.configPath.startsWith("/") ||
    input.configPath.length > SSH_PATH_MAX_CHARS
  ) {
    throw new Error("config path must be absolute POSIX");
  }
  const argv = [input.sshBin, "-F", input.configPath];
  if (input.forceTty === true) argv.push("-tt");
  argv.push("-p", String(snapshot.port));
  if (snapshot.user !== null) argv.push("-l", snapshot.user);
  if (snapshot.hostKeyAlias !== null) argv.push("-o", `HostKeyAlias=${snapshot.hostKeyAlias}`);
  if (snapshot.proxyJumps.length > 0) {
    argv.push("-o", `ProxyJump=${snapshot.proxyJumps.map(hopToken).join(",")}`);
  }
  argv.push("--", snapshot.host);
  if (input.remoteCommand !== undefined) argv.push(input.remoteCommand);
  return argv;
}

/**
 * The remote command line for a structured run (SSH-SUPPORT.md §3: "A failed
 * directory change must prevent command execution"). The directory is POSIX
 * DATA ({@link shellQuote}-quoted — it may be a path the human chose through
 * a picker, never shell material); the command is the ONE intentional shell
 * code in this contract and rides after `&&` so a failed `cd` short-circuits
 * the remote shell before it runs anything.
 */
export function remoteCommandLine(command: string, remoteDir: string | null): string {
  if (remoteDir === null) return command;
  return `cd ${shellQuote(remoteDir)} && ${command}`;
}

/**
 * The remote command line for a managed terminal: start in the approved
 * directory under the destination account's login shell, and when the `cd`
 * fails, do NOT drop into a session at some other directory — the pane's
 * ssh exits and the pane ends with it (no misleading start location, no
 * connecting-node shell fallback, §3).
 */
export function remoteTerminalLine(remoteDir: string | null): string | undefined {
  if (remoteDir === null) return undefined;
  return `cd ${shellQuote(remoteDir)} && exec "\${SHELL:-/bin/sh}" -l`;
}

/**
 * The COMPLETE environment of a managed ssh child (§2, "Spawn using explicit
 * argv and a minimal environment").
 *
 * An allowlist, never an inheritance: no app secrets, no Subshell
 * credentials, no preset env, no loader overrides (`DYLD_*`/`LD_*` are not
 * even consultable here), no shell startup overrides, and **never an askpass
 * hook** — `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`/`DISPLAY` are absent BY
 * EXCLUSION, which is what keeps BatchMode honest (a refused auth is a fast
 * named failure, never a GUI prompt an attacker-controlled binary answers).
 * The authentication-agent socket is the one credential-adjacent variable
 * that may ride, and only when the APPROVED SNAPSHOT names it — the
 * connecting account's trusted setup decided that path at resolution time.
 */
export async function sshChildEnv(
  snapshot: SshConnectionSnapshotWire,
  homeDir: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: await sshChildPath(),
    HOME: homeDir,
  };
  for (const key of ["USER", "LOGNAME", "LANG", "TMPDIR"]) {
    const value = baseEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("LC_") && value !== undefined && value !== "") env[key] = value;
  }
  if (snapshot.authAgentSocket !== null) env.SSH_AUTH_SOCK = snapshot.authAgentSocket;
  return env;
}

/**
 * The env for a MANAGED TERMINAL pane's pane-command string (tmux runs it
 * through `sh -c` after `env -i`). Same allowlist minus PATH discovery
 * (already resolved) and with the pane's OWN `TERM` — the literal `$TERM`
 * expands inside the pane's shell, the same trick `assembleHarnessCommand`
 * uses, because a hardcoded TERM would describe the wrong terminal.
 */
export function sshTerminalEnvPairs(
  snapshot: SshConnectionSnapshotWire,
  homeDir: string,
  path: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = {
    PATH: path,
    HOME: homeDir,
  } as Record<string, string>;
  for (const key of ["USER", "LOGNAME", "LANG", "TMPDIR"]) {
    const value = baseEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("LC_") && value !== undefined && value !== "") env[key] = value;
  }
  if (snapshot.authAgentSocket !== null) env.SSH_AUTH_SOCK = snapshot.authAgentSocket;
  return env;
}

/**
 * Assemble the pane command string for an ssh-terminal: `env -i` with the
 * allowlist, `TERM="$TERM"` (pane-expanded), then the ssh argv, every token
 * shell-quoted. This is the harness-launch posture applied to ssh: the launch
 * DOES become a shell string via tmux, and `shellQuote` on every token is the
 * load-bearing defense — never reason from "there is no shell string".
 */
export function sshTerminalPaneCommand(
  envPairs: Record<string, string>,
  sshArgv: string[],
  remoteCommand: string | undefined,
): string {
  const argv = remoteCommand === undefined ? sshArgv : [...sshArgv, remoteCommand];
  const envArgs = Object.entries(envPairs).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return `env -i ${envArgs.join(" ")} TERM="$TERM" ${argv.map(shellQuote).join(" ")}`;
}

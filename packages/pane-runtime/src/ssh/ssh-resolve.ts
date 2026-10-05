import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import {
  type NodeSshResolveOutcomeWire,
  parseSshConnectionSnapshot,
  SSH_MAX_PROXY_HOPS,
  SSH_PROBE_DEADLINE_MS,
  type SshConnectionSnapshotWire,
  type SshErrorCode,
  type SshHopWire,
} from "@internal/subshell-protocol";
import { defaultSshConfigPath, type SshHostBlock, type SshWalkBudget, walkSshConfig } from "./ssh-discover.js";
import { runSshProcess, sshChildPath } from "./ssh-spawn.js";

/**
 * Resolution: alias in, approved snapshot out (SSH-SUPPORT.md §2: "Human-only
 * resolution followed by an approved normalized configuration").
 *
 * The evaluator is OpenSSH itself — `ssh -G <alias>` prints the effective
 * config for a destination without connecting, which is the only answer that
 * honors include precedence, defaults, and `Match` the way the real client
 * would apply them. What this module adds is the FILTER: every resolved
 * setting is either represented in the frozen snapshot grammar or refused by
 * name, and the finished snapshot is re-validated through
 * {@link parseSshConnectionSnapshot} before it is ever returned, so the
 * resolver cannot emit a shape the wire would later reject.
 *
 * **Disclosure this step owes the human:** `ssh -G` EVALUATES the account's
 * config, which means a trusted `Match exec` can run a LOCAL command during
 * resolution. The walk separately detects `Match exec` and refuses to make
 * such a config a saved connection, but detection happens after the eval, so
 * the refusal is about what gets stored, not about what already ran. The
 * resolve command's JSDoc on the wire names this; UI copy must render it
 * before the button (SSH-SUPPORT.md §2, Configuration is executable).
 */

/** Inputs {@link resolveSshAliasConfig} needs; every one is injectable so tests never touch a developer's `~/.ssh`. */
export interface SshResolutionDeps {
  /** Absolute path of the ssh(1) binary (the agent resolves the ladder; nothing here re-searches PATH to pick the executable). */
  sshBin: string;
  /** The connecting account's home directory (HOME for the child, `~` expansion). */
  homeDir: string;
  /** The account's config file (default `<homeDir>/.ssh/config`). */
  configPath?: string;
  /** Process env whose `SSH_AUTH_SOCK` participates in agent resolution (default: this process's). */
  env?: Record<string, string | undefined>;
  /** The connecting OS account name (display fact); default `os.userInfo().username` when obtainable. */
  connectingAccount?: string;
  /** Overall deadline for the `ssh -G` evaluation. */
  timeoutMs?: number;
  /** Config-walk budgets (tests pass small ones). */
  walkBudget?: SshWalkBudget;
}

/** One line of `ssh -G` output, lowercased keyword + raw argument string. */
type GLine = { keyword: string; value: string };

/** Refusal with no config keywords to name (the code itself is the whole diagnosis). */
function refuse(code: SshErrorCode, settings: string[] = []): NodeSshResolveOutcomeWire {
  return { accepted: false, code, settings };
}

/** Parse `-G` stdout: one `keyword value...` line each; blank/continuation-free by OpenSSH's own format. */
function parseDashG(stdout: string): GLine[] {
  const lines: GLine[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cut = line.search(/\s/);
    if (cut === -1) lines.push({ keyword: line.toLowerCase(), value: "" });
    else lines.push({ keyword: line.slice(0, cut).toLowerCase(), value: line.slice(cut + 1).trim() });
  }
  return lines;
}

/** All values of any of the accepted spellings, whitespace-split (the list options' own delimiter). */
function valuesOf(g: GLine[], ...keywords: string[]): string[] {
  const out: string[] = [];
  for (const line of g) {
    if (keywords.includes(line.keyword)) out.push(...line.value.split(/\s+/).filter((v) => v !== ""));
  }
  return out;
}

/** True when any value of the keyword is "set" (not none/off/no/0 — the option's unconfigured spelling). */
function setWhere(g: GLine[], keyword: string, unconfigured: readonly string[] = ["none"]): boolean {
  return setWhereAny(g, [keyword], unconfigured);
}

function setWhereAny(g: GLine[], keywords: readonly string[], unconfigured: readonly string[] = ["none"]): boolean {
  return valuesOf(g, ...keywords).some((v) => !unconfigured.includes(v.toLowerCase()));
}

/**
 * The forward keyword, BOTH ways. OpenSSH's `ssh -G` echoes the option
 * keyword, and the historical/config spellings of these three differ across
 * versions (`LocalForward` vs the `locallyforward` echo, likewise remote) —
 * accepting both spellings means a version drift can only ever make us
 * REFUSE on a present directive, never miss one. Missing a forward would be
 * the silent-omission defect §2 names.
 */
const FORWARD_LOCAL_KEYWORDS = ["localforward", "locallyforward"];
const FORWARD_REMOTE_KEYWORDS = ["remoteforward", "remotelyforward"];
const FORWARD_DYNAMIC_KEYWORDS = ["dynamicforward"];

/** Parse one ProxyJump token `[user@]host[:port]` into the frozen hop shape; bracketed IPv6 keeps its brackets (the snapshot grammar wants them). */
export function parseProxyHop(token: string, defaultUser: string | null): SshHopWire | null {
  if (token === "") return null;
  let rest = token;
  let user: string | null = null;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (user === "") user = null;
  } else if (at === 0) {
    return null; // "@host" — an empty user is not a route fact to store
  }
  let port: number | null = null;
  let host = rest;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return null;
    host = rest.slice(0, close + 1);
    const tail = rest.slice(close + 1);
    if (tail.startsWith(":")) {
      port = Number(tail.slice(1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    } else if (tail !== "") {
      return null;
    }
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon !== -1) {
      host = rest.slice(0, colon);
      port = Number(rest.slice(colon + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    }
  }
  if (host === "") return null;
  return { host, user: user ?? defaultUser, port: port ?? 22 };
}

/** Case-insensitive alias membership among a Host block's pattern tokens (negations excluded — `!x` never makes a block match x). */
function blockMatchesAlias(block: SshHostBlock, alias: string): boolean {
  return block.tokens.some((t) => !t.startsWith("!") && !/[?*]/.test(t) && t.toLowerCase() === alias.toLowerCase());
}

/**
 * Resolve one alias on this machine into the approved snapshot, or a refusal
 * naming WHY (§2: "refuse with a named limitation rather than silently
 * changing connection semantics"). A refusal is an ACCEPTED command answer
 * (it rides `accepted:false`, in-the-data) so the human can read which
 * setting blocked and go edit the config.
 *
 * @param alias - the config token the human chose (also a manual destination
 *   when the config has no block for it and the token is itself a hostname)
 * @param deps - binary path, home, config path, env, budgets (all injectable)
 */
export async function resolveSshAliasConfig(
  alias: string,
  deps: SshResolutionDeps,
): Promise<NodeSshResolveOutcomeWire> {
  // Shape gate FIRST (defense-in-depth beside the wire parser): this string
  // reaches `ssh -G` as an argv tail — an option-like or control-bearing
  // token must die here, not at getopt.
  if (alias.length === 0 || alias.length > 253 || alias.startsWith("-") || /\s|\p{Cc}/u.test(alias)) {
    return refuse("config_missing");
  }
  const configPath = deps.configPath ?? defaultSshConfigPath(deps.homeDir);
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const connectingAccount = deps.connectingAccount ?? safeUsername();

  // The structural walk happens before the evaluation: `Match exec` is a
  // config-shape fact the walk sees without running anything, and alias
  // membership (manual alias vs config alias) comes from the same walk the
  // discovery command answers with — one parser, one truth about "in config".
  const walk = walkSshConfig(configPath, deps.homeDir, deps.walkBudget);
  if (walk.matchExecSeen) return refuse("unsupported_setting", ["Match exec"]);

  const argv = [deps.sshBin, "-G"];
  if (existsSync(configPath)) argv.push("-F", configPath);
  argv.push(alias);
  const childEnv: Record<string, string> = {
    PATH: await sshChildPath(),
    HOME: deps.homeDir,
    ...(env.LANG ? { LANG: env.LANG } : {}),
    ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}),
    ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}),
  };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("LC_") && v) childEnv[k] = v;
  const run = await runSshProcess(argv, childEnv, deps.timeoutMs ?? SSH_PROBE_DEADLINE_MS);
  if (run.timedOut || run.spawnError || run.code !== 0) {
    // The evaluator could not be brought to answer: the destination cannot be
    // reduced to one reviewable route. `config_ambiguous` is the frozen code
    // for "cannot be uniquely resolved"; settings carries ssh's own last line
    // so the human sees a hint that is not a diagnosis (never a config blob).
    const last = run.stderr.trim().split("\n").pop() ?? "";
    return refuse("config_ambiguous", last === "" ? [] : [`ssh -G failed: ${last.slice(0, 200)}`]);
  }
  const g = parseDashG(run.stdout);

  // --- forbidden settings: any of these present at RESOLUTION fails setup ---
  const blocked: string[] = [];
  if (setWhere(g, "proxycommand")) blocked.push("ProxyCommand");
  if (setWhereAny(g, FORWARD_LOCAL_KEYWORDS)) blocked.push("LocalForward");
  if (setWhereAny(g, FORWARD_REMOTE_KEYWORDS)) blocked.push("RemoteForward");
  if (setWhereAny(g, FORWARD_DYNAMIC_KEYWORDS)) blocked.push("DynamicForward");
  if (setWhere(g, "tunnel", ["no"])) blocked.push("Tunnel");
  if (setWhere(g, "permitremoteopen")) blocked.push("PermitRemoteOpen");
  if (setWhere(g, "permitlocalcommand", ["no"])) blocked.push("PermitLocalCommand");
  if (setWhere(g, "localecalcommand")) blocked.push("LocalCommand");
  if (setWhere(g, "remotecommand")) blocked.push("RemoteCommand");
  if (g.some((l) => l.keyword === "sendenv" && l.value !== "")) blocked.push("SendEnv");
  if (g.some((l) => l.keyword === "setenv" && l.value !== "")) blocked.push("SetEnv");
  if (setWhere(g, "knownhostscommand")) blocked.push("KnownHostsCommand");
  if (blocked.length > 0) return refuse("unsupported_setting", blocked);
  // NOTE on what is NOT refused here: ForwardAgent/ForwardX11/ControlPath/
  // EscapeChar/GSSAPI found in config are killed by the MANDATORY runtime
  // policy (ssh-render.ts applies it to every hop regardless), so they change
  // nothing the human approved and stay representable. A ProxyCommand has no
  // kill switch — it IS the route — so it fails setup instead. That asymmetry
  // is the grammar's, not an accident.

  // --- destination facts ---
  const hostValues = valuesOf(g, "hostname");
  const hostLine = valuesOf(g, "host")[0] ?? alias;
  const host = hostValues[0] ?? hostLine;
  const matchedBlocks = walk.hostBlocks.filter((b) => blockMatchesAlias(b, alias));
  const inConfig = matchedBlocks.length > 0;
  if (!inConfig) {
    // Manual-alias path: only legitimate when OpenSSH itself treated the
    // token as the hostname (no config rewrite happened). Anything else means
    // the token is neither an alias nor a destination the account can reach.
    if (host.toLowerCase() !== alias.toLowerCase()) return refuse("config_missing");
  } else {
    // Two blocks setting conflicting destination facts cannot be reduced to
    // one route a human reviewed (first-obtained-wins makes -G deterministic,
    // but the ORDER that decided it is config-invisible noise the reviewer
    // would never catch) — §2's config_ambiguous.
    const conflicts = new Set<string>();
    for (const b of [...walk.globalDirectives, ...matchedBlocks.flatMap((m) => m.directives)]) {
      if (b.keyword === "hostname" && b.value !== "") conflicts.add(b.value.toLowerCase());
      if (b.keyword === "port" && b.value !== "") conflicts.add(`port:${b.value}`);
    }
    if (conflicts.size > 1) return refuse("config_ambiguous");
  }

  const portRaw = Number(valuesOf(g, "port")[0] ?? "22");
  const port = Number.isInteger(portRaw) ? portRaw : NaN;
  const userRaw = valuesOf(g, "user")[0] ?? null;
  // -G always prints SOME user (the connecting account's own default); null
  // means exactly that default, so the snapshot stores null for it and a real
  // value only when the config chose a different account.
  const user = userRaw !== null && userRaw.toLowerCase() !== (connectingAccount ?? "").toLowerCase() ? userRaw : null;

  // --- trust + identity refs (paths on THIS machine; the snapshot carries refs, never contents) ---
  const identityFiles = valuesOf(g, "identityfile").filter((v) => v !== "" && v !== "none");
  const certificateFiles = valuesOf(g, "certificatefile").filter((v) => v !== "" && v !== "none");
  const knownHostsFiles = valuesOf(g, "userknownhostsfile").filter((v) => v !== "" && v !== "none");
  const hostKeyAliasRaw = valuesOf(g, "hostkeyalias")[0] ?? "none";
  const hostKeyAlias = hostKeyAliasRaw !== "none" && hostKeyAliasRaw !== "" ? hostKeyAliasRaw : null;

  // --- agent: ONLY an absolute socket from the account's trusted setup (an
  // explicit IdentityAgent path, else the account's own SSH_AUTH_SOCK) ---
  const identityAgent = valuesOf(g, "identityagent")[0] ?? null;
  let authAgentSocket: string | null = null;
  if (identityAgent?.startsWith("/")) {
    authAgentSocket = identityAgent;
  } else if (identityAgent !== "none" && env.SSH_AUTH_SOCK?.startsWith("/")) {
    // "ssh-agent" (and the keyword's absence) mean "the account's agent";
    // any OTHER future spelling fails closed to null, never to env.
    authAgentSocket = env.SSH_AUTH_SOCK;
  }

  // --- jump chain: comma-separated per directive, all directives concatenated in config order ---
  const hops: SshHopWire[] = [];
  for (const line of g.filter((l) => l.keyword === "proxyjump")) {
    for (const token of line.value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")) {
      const hop = parseProxyHop(token, user);
      if (!hop) return refuse("config_ambiguous", ["ProxyJump"]);
      hops.push(hop);
    }
  }
  if (hops.length > SSH_MAX_PROXY_HOPS) return refuse("proxy_chain_too_long");

  const candidate = {
    alias,
    host,
    user,
    port,
    identityFiles,
    certificateFiles,
    authAgentSocket,
    knownHostsFiles,
    hostKeyAlias,
    proxyJumps: hops,
    proxyCommand: null,
    forwards: null,
    tunnels: null,
    localCommands: null,
    remoteCommand: null,
    sendEnv: null,
    setEnv: null,
    escapes: null,
  } satisfies SshConnectionSnapshotWire;

  const approved = parseSshConnectionSnapshot(candidate);
  if (approved === null) {
    // The normalized facts do not fit the grammar (a hostname with spaces in
    // config, an out-of-range port, a relative identity path from a broken
    // build): unrepresentable, and refused whole.
    return refuse("config_ambiguous");
  }
  return {
    accepted: true,
    snapshot: approved,
    ...(connectingAccount !== undefined ? { connectingAccount } : {}),
  };
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

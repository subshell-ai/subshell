import type { NetworkAddress, NetworkContext, NetworkHint, NetworkStatus, PluginHost } from "@subshell-ai/plugin-api";
import {
  firstLine,
  isManagementConnected,
  type NetbirdStatusJson,
  parseStatusJson,
  peerFqdn,
  peerIpv4,
  resolveBinary,
  runNetbird,
} from "./cli.js";
import { daemonDownHints, nameserverGroupHint, needsLoginHints, notInstalledHints } from "./hints.js";

/** A status read is one CLI call, so it is bounded well below the host's 30s default. */
const STATUS_TIMEOUT_MS = 15_000;

/**
 * Everything one status read learned, not just what the contract reports.
 *
 * `publish` needs facts `NetworkStatus` has no field for — this machine's FQDN
 * and peer IP, in the exact form the addresses need — and re-running the CLI to
 * get them would be a second read that can disagree with the first. So the read
 * is done once and both halves are returned.
 */
export interface NetbirdRead {
  /** What {@link NetworkPlugin.status} reports verbatim. */
  status: NetworkStatus;
  /** The parsed `status --json`, or null when there was nothing to parse. */
  json: NetbirdStatusJson | null;
  /** The resolved CLI, or null when NetBird is not installed. */
  binary: string | null;
}

/**
 * Reads where this host stands with NetBird, in one pass.
 *
 * NEVER throws, which is the whole shape of it: an absent binary, a dead daemon,
 * a refused socket and a body that will not parse are all states with a hint,
 * because this runs on every page load and a rejection there is a page that says
 * nothing at all.
 *
 * **The ladder stops at `joined`.** A connected NetBird daemon means this machine
 * is on the network and reachable at its addresses, which is everything the
 * plugin can OBSERVE — the distinction between `joined` and `published` lives
 * entirely in the host's trusted-origins config, which a plugin is forbidden to
 * read. `publish()` records the publish and adds those origins; a later status
 * read still returns `joined`, because from the daemon's side nothing changed.
 * The plugin never claims a state it cannot see; the manifest instead declares
 * `publishImplicit`, which tells the host that for THIS plugin its own publish
 * record is the `published` state — `publishStateVisible` in
 * `apps/server/api/src/services/network/state.ts` reads it and upgrades the
 * row. The daemon's answer stays exactly as honest as it is here.
 */
export async function readNetwork(host: PluginHost, ctx: NetworkContext): Promise<NetbirdRead> {
  const binary = await resolveBinary(host);
  if (!binary) {
    return { binary: null, json: null, status: { state: "not-installed", addresses: [], hints: notInstalledHints() } };
  }

  const result = await runNetbird(host, binary, ["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
  const json = result.stdout.trim() === "" ? null : parseStatusJson(result.stdout);

  // A failed run, an empty body, or a body that will not parse all land here.
  // NetBird has no separate `needs-privilege` state (§ 8), and its
  // peer-credential authorisation is UNMEASURED (§ 10.4), so a permission denial
  // and a dead daemon are reported identically and generically — the plugin
  // refuses to guess which one it saw.
  if (result.code !== 0 || json === null) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      binary,
      json,
      status: {
        state: "daemon-down",
        addresses: [],
        hints: daemonDownHints(detail || "NetBird did not report a status this server could read."),
      },
    };
  }

  const identity = readIdentity(json);

  if (!isManagementConnected(json)) {
    return {
      binary,
      json,
      status: { state: "needs-login", addresses: [], identity, hints: needsLoginHints(undefined) },
    };
  }

  const addresses = netbirdAddresses(json, ctx.port);
  const hints: NetworkHint[] = [];
  // Said where someone deciding whether to publish is looking: the FQDN address
  // is offered, but it only resolves for a peer that has a nameserver group.
  if (peerFqdn(json)) hints.push(nameserverGroupHint());
  return { binary, json, status: { state: "joined", addresses, identity, hints } };
}

/**
 * What this machine is called on this network, for the UI's identity line.
 *
 * Hostname and version, and ONLY where the status document answers them — the
 * spec reads them from the JSON rather than probing, so no second `host.run`
 * happens just to fill a label.
 *
 * **Measured on 0.66.4**, the version lives in `daemonVersion` and `cliVersion`,
 * and the daemon leads: the version line describes the process that is running,
 * not the CLI that asked it. The two spellings the specs guessed
 * (`netbirdVersion`, `version`) follow as fallbacks. `hostname` is absent from
 * that document entirely — `fqdn` carries the name — so a 0.66.4 identity is
 * honestly a version and nothing else.
 */
function readIdentity(json: NetbirdStatusJson): NetworkStatus["identity"] {
  const hostname = json.hostname?.trim();
  const version =
    json.daemonVersion?.trim() || json.cliVersion?.trim() || json.netbirdVersion?.trim() || json.version?.trim();
  return {
    ...(hostname ? { hostname } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * The addresses this server can be reached at over NetBird.
 *
 * Two kinds, and the order is load-bearing: the host promotes `addresses[0]`
 * when asked to set the base URL, and there is no secure-context address here to
 * prefer, so the FQDN leads and the raw IP follows.
 *
 * Both are `http` with `secureContext: false` — NetBird carries the traffic over
 * WireGuard end to end, but the browser sees a plain origin and refuses passkeys
 * and `Secure` cookies there. That is stated per address rather than once,
 * because it is a property of the address the reader is about to click.
 */
function netbirdAddresses(json: NetbirdStatusJson, port: number): NetworkAddress[] {
  const addresses: NetworkAddress[] = [];
  const fqdn = peerFqdn(json);
  if (fqdn)
    addresses.push({ url: `http://${fqdn}:${port}`, scheme: "http", label: "NetBird FQDN", secureContext: false });
  const ip = peerIpv4(json);
  if (ip) addresses.push({ url: `http://${ip}:${port}`, scheme: "http", label: "NetBird IP", secureContext: false });
  return addresses;
}

import type { NetworkContext, NetworkHint, NetworkStatus, PluginHost } from "@subshell-ai/plugin-api";
import { DOWNLOADS_DOCS_URL, firstLine, readSettings, resolveBinary, TOKEN_SECRET, tunnelAddress } from "./cli.js";

/**
 * Where this host stands with its Cloudflare Tunnel.
 *
 * **The plugin answers presence and settings completeness, never process
 * state** (spec 2026-09-15 phase 2-3 § 6). That is a real difference from the
 * mesh plugins: their daemons outlive this server and can be ASKED (`tailscale
 * status --json`), while this plugin's daemon IS the host's supervised child —
 * there is nothing outside it to interrogate. `published ⇔ the supervisor
 * reports running` is the host's merge to make (it holds `processState`), and
 * `network-view.ts` does exactly that when building a row. The highest rung
 * this function can honestly reach on its own is `joined`: the binary is here,
 * the settings are complete, the token is stored, and a publish would work.
 *
 * Never throws: an absent binary is a state with a hint, same contract as
 * every other `status()`.
 */
export async function readNetwork(host: PluginHost, ctx: NetworkContext): Promise<NetworkStatus> {
  const binary = await resolveBinary(host);
  if (!binary) {
    return {
      state: "not-installed",
      addresses: [],
      // One sentence naming the state; the install button (darwin) and the
      // apt-repo step (linux) render from the manifest, and repeating them
      // here would print the card twice — the tailscale lesson.
      hints: [
        {
          text: "cloudflared, the Cloudflare Tunnel connector, is not installed on this machine.",
          docsUrl: DOWNLOADS_DOCS_URL,
        },
      ],
    };
  }

  const identity = await readIdentity(host, binary);
  const settings = readSettings(ctx);
  const hasToken = ctx.secrets.has(TOKEN_SECRET);

  if (settings === null || !hasToken) {
    const hints: NetworkHint[] = [];
    if (!hasToken) {
      hints.push({
        text: "This machine is not connected to its tunnel yet. Paste the tunnel token from Zero Trust → Networks → Tunnels → the tunnel's connector.",
      });
    }
    if (settings === null) {
      // "connecting", because the required settings gate the join as well as
      // the publish (`configurationRefusal`'s join half exempts only the
      // secret) — a hint naming only the far end sent people to press Connect
      // first and eat the 409.
      hints.push({ text: "Set the hostname, team domain and application AUD before connecting or publishing." });
    }
    return { state: "needs-login", addresses: [], hints, ...(identity ? { identity } : {}) };
  }

  return {
    state: "joined",
    addresses: [tunnelAddress(settings.hostname)],
    ...(identity ? { identity } : {}),
    hints: [frontDoorHint(), ingressPortHint()],
  };
}

/**
 * What this machine's connector is called, for the identity line.
 *
 * The version comes from the host's own bounded probe. The connector's NAME
 * on the tunnel is chosen in the Cloudflare dashboard and there is no CLI
 * read for it without an API token this plugin does not have, so the honest
 * identity is the version and nothing else.
 */
async function readIdentity(host: PluginHost, binary: string): Promise<NetworkStatus["identity"] | undefined> {
  const raw = await host.probeVersion(binary, ["version"]);
  const version = raw ? firstLine(raw) : "";
  return version ? { version } : undefined;
}

/**
 * The disclosure the public hostname needs beside it (§ 6).
 *
 * An Access assertion is a FRONT DOOR, never a session: it decides who may
 * reach the tunnel, and Subshell's own login still runs behind it. Stated on
 * every read at or above `joined`, because the address card is where someone
 * decides whether to sign in from their phone.
 */
function frontDoorHint(): NetworkHint {
  return {
    text: "Cloudflare Access is the front door for this address — it decides who may reach the tunnel. Subshell's own sign-in still runs behind it.",
  };
}

/**
 * The § 5.6 trap, said where someone could hit it.
 *
 * The port the tunnel routes to lives in the public hostname's ingress, on
 * the dashboard, and the connector token cannot change it. Changing
 * `SERVER_PORT` therefore does NOT move this address's target — unlike every
 * mesh plugin, whose publish rebuilds against `ctx.port`. The boot reconcile
 * keeps the supervisor running for exactly this reason, so the honest place
 * for the warning is the row, always.
 */
function ingressPortHint(): NetworkHint {
  return {
    text: "The tunnel routes to the port set in the Cloudflare dashboard — if this server's port changes, update the public hostname's ingress there.",
  };
}

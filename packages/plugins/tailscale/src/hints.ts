import type { NetworkHint, PluginPlatform } from "@subshell-ai/plugin-api";

/** Where Tailscale documents enabling certificates and MagicDNS for a tailnet. */
export const HTTPS_DOCS_URL = "https://tailscale.com/kb/1153/enabling-https";

/** Where Tailscale documents the CLI, including `set --operator`. */
export const CLI_DOCS_URL = "https://tailscale.com/kb/1080/cli";

/**
 * Where the open-source macOS daemon is documented.
 *
 * Distinct from {@link INSTALL_DOCS_URL.darwin}: that page is about installing
 * Tailscale on a Mac, which since the app became the recommended route mostly
 * means the app. This one is the daemon specifically, and it is the page a
 * person needs once they have chosen that route.
 */
export const TAILSCALED_MACOS_DOCS_URL = "https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS";

/**
 * Where Tailscale documents INSTALLING, per platform.
 *
 * Separate from {@link CLI_DOCS_URL} because they answer different questions
 * and the reader of a "not installed" row is asking the first one. Linux used
 * to get the CLI reference here — a page that assumes the thing is already
 * installed — while the manifest's own privileged step pointed at the right
 * page two lines below it.
 */
const INSTALL_DOCS_URL: Record<PluginPlatform, string> = {
  darwin: "https://tailscale.com/kb/1016/install-mac",
  linux: "https://tailscale.com/kb/1031/install-linux",
};

/**
 * What to say when there is no `tailscale` binary at all.
 *
 * ONE sentence, and deliberately no commands. The install sequence lives in
 * `network.privileged` in package.json, as data a page renders before any of
 * this code is imported — so a host already has it, and a status that
 * re-emitted the same steps did not keep the two from drifting (the reason
 * first given for doing it) but made the card render the whole sequence
 * TWICE: "1. Install … 2. Allow this server to control Tailscale", then this
 * sentence, then "3. Install … 4. Allow this server to control Tailscale".
 *
 * What a status knows and a manifest cannot is which state this machine is in.
 * That is this sentence, and it is the whole contribution.
 */
export function notInstalledHints(platform: PluginPlatform): NetworkHint[] {
  return [
    {
      text: "Tailscale is not installed on this machine.",
      docsUrl: INSTALL_DOCS_URL[platform],
    },
  ];
}

/**
 * What to say when the CLI is here but its daemon is not answering.
 *
 * The two platforms get different shapes, not just different commands. On
 * Linux `tailscaled` is a systemd unit the install step already put there, so
 * the one useful line starts it. On macOS there are TWO ways to be running
 * Tailscale — the app and the command-line daemon — and this plugin cannot
 * tell which one a machine took: the app's CLI integration installs a two-line
 * shell wrapper at `/usr/local/bin/tailscale`, which hides the bundle it execs.
 * So macOS says both, app first (most people have it, and opening it is the
 * cheaper thing to try), and the two sentences cost less than a wrong guess.
 */
export function daemonDownHints(platform: PluginPlatform, detail: string): NetworkHint[] {
  const hints: NetworkHint[] =
    platform === "darwin"
      ? [
          {
            text: "Tailscale is not running on this machine. If you use the Tailscale app, open it and sign in, then re-check.",
          },
          {
            text: "If you installed the command-line daemon instead, install and start it, then re-check.",
            command: "sudo tailscaled install-system-daemon",
            docsUrl: TAILSCALED_MACOS_DOCS_URL,
            privileged: true,
          },
        ]
      : [
          {
            text: "The Tailscale daemon is not running. Start it, then re-check.",
            command: "sudo systemctl start tailscaled",
            docsUrl: CLI_DOCS_URL,
            privileged: true,
          },
        ];
  // The daemon's own words, last: they name the actual socket or error, and
  // they are the only part of this that can explain a case the advice above
  // does not fix.
  if (detail) hints.push({ text: detail });
  return hints;
}

/**
 * What to say when the daemon is up and refuses this OS user.
 *
 * One command, and it is the whole fix: Tailscale's `--operator` grant is what
 * lets a non-root process drive the daemon, and without it every verb this
 * plugin issues fails the same way.
 */
export function needsPrivilegeHints(userName: string): NetworkHint[] {
  return [
    {
      text: "This server is not allowed to control Tailscale yet. Grant its user access to the daemon, then re-check.",
      command: `sudo tailscale set --operator=${userName}`,
      docsUrl: CLI_DOCS_URL,
      privileged: true,
    },
  ];
}

/**
 * What to say when this tailnet issues no certificates.
 *
 * Not an error and not something this machine can fix: HTTPS certificates and
 * MagicDNS are tailnet-wide settings in the admin console. Stated as a hint on
 * every read (rather than only when a publish is attempted) because the
 * address list is visibly poorer without them, and "why is there no https
 * address" should be answered where the addresses are.
 */
export function httpsUnavailableHint(): NetworkHint {
  return {
    text: "Tailscale can give this server an HTTPS address once you enable HTTPS certificates and MagicDNS for your tailnet.",
    docsUrl: HTTPS_DOCS_URL,
  };
}

/**
 * What publishing with Tailscale Serve discloses, said BEFORE the press.
 *
 * `tailscale serve --https` provisions a real Let's Encrypt certificate for
 * this machine's MagicDNS name, and every publicly-trusted certificate is
 * recorded in Certificate Transparency logs — which are public and indexed.
 * So the machine's NAME becomes public knowledge, permanently, while the
 * server behind it stays reachable only from the tailnet.
 *
 * Nobody would guess that from a button labelled Publish, and it cannot be
 * undone once the certificate is issued. It is emitted only when certificates
 * are actually available, because on a tailnet without them the honest next
 * step is `httpsUnavailableHint` and this would be advice about something that
 * cannot happen yet.
 */
export function certificateTransparencyHint(dnsName: string): NetworkHint {
  return {
    text: `Tailscale Serve gets a public certificate for ${dnsName}. That name appears in public Certificate Transparency logs, so this machine's name becomes public — the server itself stays private to your tailnet.`,
    docsUrl: HTTPS_DOCS_URL,
  };
}

/**
 * The words for Tailscale's own hosted control service, for the sentence that
 * must name it without naming its URL.
 */
export const TAILSCALE_SERVICE_LABEL = "Tailscale's own service";

/**
 * What to say when the daemon positively reports a SELF-HOSTED control server
 * (the 2026-09-16 amendment to § 8's non-policing, mirroring the headscale
 * plugin's ownership gate with the answer inverted).
 *
 * One sentence and NO command: `tailscale logout` would tear down someone
 * else's enrollment, and this plugin was not asked to manage that tailnet.
 * The machine is not broken — it is just not on the network this row covers,
 * which is the whole sentence.
 * @param where - the host the daemon named, from `controlServerHost`
 */
export function foreignControlServerHint(where: string): NetworkHint[] {
  return [
    {
      text: `This machine's Tailscale belongs to ${where}, not to ${TAILSCALE_SERVICE_LABEL}. This row covers only machines connected to Tailscale's own service.`,
    },
  ];
}

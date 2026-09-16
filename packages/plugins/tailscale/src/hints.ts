import type { NetworkHint, PluginPlatform } from "@subshell-ai/plugin-api";
import { manifest } from "./manifest.js";

/** Where Tailscale documents enabling certificates and MagicDNS for a tailnet. */
export const HTTPS_DOCS_URL = "https://tailscale.com/kb/1153/enabling-https";

/** Where Tailscale documents the CLI, including `set --operator`. */
export const CLI_DOCS_URL = "https://tailscale.com/kb/1080/cli";

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
 * The manifest's privileged steps for one platform, as hints.
 *
 * The steps live in package.json so a page can print them before any of this
 * code is imported (spec: the `network` block is data). Rendering them here
 * too, from the same bytes, is what keeps the "install it first" hint and the
 * "here is what to run" panel from drifting into two different commands.
 *
 * Every one of them is marked `privileged`, which is the field that tells the
 * host never to run it: the server has no terminal to answer a password
 * prompt, so a `sudo` line is something a person copies.
 */
export function privilegedHints(platform: PluginPlatform): NetworkHint[] {
  const steps = manifest.network?.privileged?.[platform] ?? [];
  return steps.map((step) => ({
    text: step.label,
    command: step.command,
    ...(step.docsUrl ? { docsUrl: step.docsUrl } : {}),
    privileged: true,
  }));
}

/**
 * What to say when there is no `tailscale` binary at all.
 *
 * Leads with the sentence and then the platform's own steps, because the
 * reader of a "not installed" row has not decided to install anything yet and
 * a bare `sudo` line with no explanation is how that decision gets made by
 * accident.
 */
export function notInstalledHints(platform: PluginPlatform): NetworkHint[] {
  return [
    {
      text: "Tailscale is not installed on this machine. Install it, then let this server drive it.",
      docsUrl: INSTALL_DOCS_URL[platform],
    },
    ...privilegedHints(platform),
  ];
}

/**
 * What to say when the CLI is here but its daemon is not answering.
 *
 * The command differs by platform for a structural reason rather than a
 * cosmetic one: on Linux `tailscaled` is a systemd unit that exists already,
 * so it is started; on macOS a Homebrew `tailscale` ships no system daemon
 * until one is installed, so the useful line is the install-daemon one.
 */
export function daemonDownHints(platform: PluginPlatform, detail: string): NetworkHint[] {
  const hints: NetworkHint[] = [
    platform === "darwin"
      ? {
          text: "The Tailscale daemon is not running. Install and start it, then re-check.",
          command: "sudo tailscaled install-system-daemon",
          docsUrl: "https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS",
          privileged: true,
        }
      : {
          text: "The Tailscale daemon is not running. Start it, then re-check.",
          command: "sudo systemctl start tailscaled",
          docsUrl: CLI_DOCS_URL,
          privileged: true,
        },
  ];
  // The daemon's own words, second: they name the actual socket or error, and
  // they are the only part of this that can explain a case the two commands
  // above do not fix.
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
      text: "This server may not drive Tailscale yet. Grant its user access to the daemon, then re-check.",
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

import type { NetworkHint, PluginPlatform } from "@subshell-ai/plugin-api";

/**
 * The sentences this plugin returns, per state.
 *
 * **Copied from `@subshell-ai/plugin-tailscale`'s `src/hints.ts`** (spec
 * 2026-09-16 § 4: "the daemon steps are tailscale's … needs-privilege
 * likewise"), with the vendor names left standing where the sentence is about
 * the TAILSCALE CLIENT — the thing that is missing, down, or refusing this
 * user is the `tailscale` binary and its daemon, whatever control server it
 * points at. What is NOT copied: the certificate-transparency disclosure (a
 * `serve --http` publish issues no public certificate, so it has nothing to
 * disclose), and the "enable HTTPS in the admin console" advice (a Headscale
 * admin console has no such switch to flip — headscale#2527), both replaced
 * by {@link httpOnlyHint} and {@link adminHint}.
 */

/** Where the tailscale CLI is documented, including `set --operator`. */
export const CLI_DOCS_URL = "https://tailscale.com/kb/1080/cli";

/** Where the open-source macOS daemon is documented. */
export const TAILSCALED_MACOS_DOCS_URL = "https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS";

/**
 * Where the HTTPS-serve gap on Headscale is tracked.
 *
 * The cited reason behind this plugin's whole publish posture: Tailscale Serve
 * over HTTPS against a Headscale is refused (the vendor table's § 8 prose names
 * headscale#2527), which is why the addresses are http and the publish page
 * says so. It is also the link an operator follows to learn the serve story
 * for their own control server — the one honest destination when § 10.3's
 * measurement is not yet made.
 */
export const HEADSCALE_SERVE_ISSUE_URL = "https://github.com/juanfont/headscale/issues/2527";

/**
 * Where the tailscale client is documented as INSTALLING, per platform.
 *
 * The client to install is Tailscale's even for a Headscale tailnet — the
 * binary is the same — so these are the tailscale plugin's pages, copied.
 */
const INSTALL_DOCS_URL: Record<PluginPlatform, string> = {
  darwin: "https://tailscale.com/kb/1016/install-mac",
  linux: "https://tailscale.com/kb/1031/install-linux",
};

/**
 * What to say when there is no `tailscale` binary at all.
 *
 * Copied from `@subshell-ai/plugin-tailscale`, and it names TAILSCALE on
 * purpose (spec 2026-09-16 § 4: "not-installed sentence names Tailscale (the
 * client)"): an operator reading "Headscale is not installed" would go looking
 * for a `headscale` binary to install on the client machine, and there is no
 * such thing — the client is `tailscale`. One sentence, no commands: the
 * install sequence is manifest data rendered beside it.
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
 * Copied from `@subshell-ai/plugin-tailscale` — § 4: the daemon steps are
 * tailscale's, two per platform. On Linux `tailscaled` is a systemd unit the
 * install already placed; on macOS the plugin cannot tell the app from the
 * command-line daemon, so it says both.
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
  if (detail) hints.push({ text: detail });
  return hints;
}

/**
 * What to say when the daemon is up and refuses this OS user.
 *
 * Copied from `@subshell-ai/plugin-tailscale` (§ 4: needs-privilege likewise).
 * The `--operator` grant is the tailscale client's own mechanism and works the
 * same against any control server.
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
 * What to say beside the http addresses, explaining why there is no https one.
 *
 * The master spec's status row for headscale: "http addresses with a hint
 * saying why". The why is the control server, not this machine: a Headscale
 * tailnet issues no certificates, so this is not a switch the operator forgot
 * and no admin-console page here would help — the cited issue is the honest
 * destination.
 */
export function httpOnlyHint(): NetworkHint {
  return {
    text: "Headscale does not issue certificates, so this address is plain http over WireGuard.",
    docsUrl: HEADSCALE_SERVE_ISSUE_URL,
  };
}

/**
 * The act the operator cannot take themselves, said on the needs-login row.
 *
 * An interactive login on a self-hosted tailnet is not finished by clicking
 * the link: an ADMIN has to approve the machine from the control server's own
 * CLI (spec 2026-09-16 § 4's `adminHint()`, and the vendor table's "finished
 * by a Headscale admin"). Without this sentence the row offers a URL and the
 * machine sits in `NeedsLogin` forever, which reads as a broken button.
 *
 * The `…` in the command is deliberate: the exact invocation
 * (`--user`, `--key`, preauthkeys) belongs to the admin's Headscale version,
 * and a copy-paste command with a placeholder inside it is a worse lie than
 * naming the verb that is missing.
 */
export function adminHint(): NetworkHint {
  return {
    text: "Ask your Headscale admin to register this machine (headscale nodes register …) once you have opened the sign-in link.",
  };
}

/** The words for Tailscale's own hosted service, shared with the tailscale plugin's copy. */
export const TAILSCALE_SERVICE_LABEL = "Tailscale's own service";

/**
 * What to say when the daemon positively belongs to a control server OTHER
 * than the one this row covers (the 2026-09-16 amendment to § 8's
 * non-policing, which the operator's live host forced: a Headscale row said
 * "Joined" on a machine enrolled to Tailscale's SaaS).
 *
 * Two shapes, because the missing piece differs:
 *
 * - **Configured:** the sentence names BOTH control servers — where the
 *   daemon goes and the URL this row wanted — and the remedy is the sentence
 *   to type in a terminal. `tailscale logout` is an unprivileged vendor verb,
 *   offered as a copyable `command` hint like the file's other command hints
 *   and NEVER run: moving this machine is the human's act, and this plugin
 *   does not tear down a tailnet it was not asked to leave.
 * - **Unconfigured:** the row has nothing to compare against and nothing it
 *   could join, so the version points at the setting instead.
 *
 * @param where - {@link TAILSCALE_SERVICE_LABEL}, or the host the daemon named
 * @param configuredUrl - this plugin's controlUrl, canonicalized, or null
 */
export function foreignControlServerHints(where: string, configuredUrl: string | null): NetworkHint[] {
  if (configuredUrl) {
    return [
      {
        text: `This machine's Tailscale belongs to ${where}, not to your configured control server (${configuredUrl}).`,
      },
      {
        text: "To move this machine onto your control server, sign it out of that one first.",
        command: "tailscale logout",
      },
    ];
  }
  return [
    {
      text: `This machine's Tailscale belongs to ${where}, and this plugin has no control server URL to check it against.`,
    },
    { text: "Set the control server URL for this plugin, then re-check." },
  ];
}

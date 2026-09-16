import type { NetworkHint } from "@subshell-ai/plugin-api";

/**
 * Where NetBird documents installing it.
 *
 * One URL for both platforms — the vendor's installation page covers the install
 * script, the apt route and the Homebrew tap, and the phase-2/3 spec names this
 * one page for every step.
 */
export const INSTALL_DOCS_URL = "https://docs.netbird.io/how-to/installation";

/**
 * What to say when there is no `netbird` binary at all.
 *
 * ONE sentence and no commands: the install sequence lives in
 * `network.privileged` in package.json, as data a page renders before any of
 * this code runs, so repeating it here would print the whole sequence twice on
 * the card. What a status knows and a manifest cannot is WHICH state this
 * machine is in — that is the whole contribution of this hint.
 */
export function notInstalledHints(): NetworkHint[] {
  return [
    {
      text: "NetBird is not installed on this machine.",
      docsUrl: INSTALL_DOCS_URL,
    },
  ];
}

/**
 * What to say when the CLI is here but its daemon is not answering.
 *
 * **Generic on purpose.** § 8 rests the "no `needs-privilege` state" claim on
 * NetBird's peer-credential authorisation (≥ 0.76), and that is UNMEASURED
 * (§ 10.4) — no live daemon was available to confirm it. So a socket error, a
 * permission refusal and an unparseable body are ALL reported here with the
 * same sentence, rather than the plugin guessing which one it saw. The
 * service-install command is the one thing that can explain all three: a daemon
 * that is not running, or not reachable, is fixed by installing and starting
 * its service.
 */
export function daemonDownHints(detail: string): NetworkHint[] {
  const hints: NetworkHint[] = [
    {
      text: "The NetBird daemon is not running or not reachable. If it is installed, start its service, then re-check.",
      command: "sudo netbird service install && sudo netbird service start",
      docsUrl: INSTALL_DOCS_URL,
      privileged: true,
    },
  ];
  // The daemon's own words, last: they name the actual socket or error, and they
  // are the only part of this that can explain a case the advice above does not.
  if (detail) hints.push({ text: detail });
  return hints;
}

/**
 * What to say when this machine is installed but not enrolled on a NetBird
 * network yet.
 *
 * A login URL from a device-flow join renders as the link to open; without one
 * the operator is pointed at joining, which is the ordinary first action.
 */
export function needsLoginHints(loginUrl: string | undefined): NetworkHint[] {
  if (loginUrl) {
    return [{ text: "Finish signing in to NetBird to put this machine on your network.", docsUrl: loginUrl }];
  }
  return [
    { text: "This machine is not on your NetBird network yet. Join one to reach this server from your other devices." },
  ];
}

/**
 * The reason the FQDN address is offered alongside the IP rather than alone.
 *
 * NetBird hands out peer names only when the account has a nameserver group
 * configured in its console. Without one the FQDN will not resolve from another
 * peer, and the IP is the address that actually works. Stated as a hint on a
 * joined/published read (not folded into the address) because the operator
 * deciding which address to try needs the caveat where the addresses are.
 */
export function nameserverGroupHint(): NetworkHint {
  return {
    text: "Peer names resolve only if your NetBird account has a nameserver group — otherwise use the IP address.",
  };
}

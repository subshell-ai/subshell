import type { PresetValidationIssue, SettingsField } from "@subshell-ai/plugin-api";
import { normalizeHostname, normalizeTeamDomain, TOKEN_SECRET } from "./cli.js";

/**
 * The four fields that define a publish, and the write-time strictness behind
 * them.
 *
 * Three of them are facts the CLOUDFLARE SIDE already holds — the hostname,
 * the team, the Access application's AUD tag — and this plugin asks for them
 * rather than discovering them because every discovery path is the vendor
 * management API, a phase 4 (spec § 14). The fourth is the credential, and it
 * is the only `secret` field shipped: write-only, stored by the host at 0600,
 * and hydrated by the host into the tunnel's environment at spawn.
 */
export function tunnelSettingsFields(): SettingsField[] {
  return [
    {
      key: "hostname",
      type: "string",
      required: true,
      label: "Hostname",
      placeholder: "subshell.example.com",
      description:
        "The public hostname the tunnel answers on. Its DNS record and its Access application are created in the Cloudflare dashboard; publishing is refused until Access covers it.",
    },
    {
      key: "teamDomain",
      type: "string",
      required: true,
      label: "Access team domain",
      placeholder: "myteam",
      description: "Your Cloudflare Access team. Assertions are verified against <team>.cloudflareaccess.com.",
    },
    {
      key: "aud",
      type: "string",
      required: true,
      label: "Access application Audience tag",
      description:
        "The AUD tag of the Access application that guards this hostname. It is in that application's summary, and every assertion is verified against it.",
    },
    {
      key: TOKEN_SECRET,
      type: "secret",
      required: true,
      label: "Tunnel token",
      // Where to find it, spelled the way the Zero Trust console spells it.
      // The card's credential box borrows this string verbatim, so it is the
      // one place the path is written down.
      placeholder: "Paste it from Zero Trust → Networks → Tunnels → the tunnel's connector",
      // The plugin's own sentence, and only that. The backup caveat belongs to
      // the PAGE — the settings form states it under every secret, because
      // `subshell-server backup` is the server's fact and no manifest should
      // have to repeat it (review, 2026-09-16).
      description: "It reaches the tunnel through the connector's own environment, never a command line.",
    },
  ];
}

/**
 * Problems with a proposed settings write (400s it, via the route).
 *
 * Strict where the stored bytes have to be exact, silent where an empty
 * string is a legitimate CLEAR (the route's own spelling), and never about
 * the secret — a plugin cannot read one and so cannot validate one.
 *
 * The hostname and team domain are validated in their BARE stored form even
 * though the runtime readers normalize: the guard compares a Host header
 * against the stored string, the row renders it, and a `https://` stored here
 * would survive in all the places this plugin does not itself re-read.
 * Correcting a paste at the field is cheaper than explaining it later.
 */
export function validateTunnelSettings(values: Record<string, string>): PresetValidationIssue[] {
  const issues: PresetValidationIssue[] = [];
  const hostname = values.hostname?.trim() ?? "";
  if (hostname !== "" && normalizeHostname(hostname) !== hostname.toLowerCase()) {
    issues.push({
      field: "hostname",
      message: "Hostname should be a bare hostname like subshell.example.com — no scheme, no path, no port.",
    });
  }
  const team = (values.teamDomain?.trim() ?? "").toLowerCase();
  // A bare slug and a full `<team>.cloudflareaccess.com` host both normalize
  // to something — the normalizer is the validator; only an answer it cannot
  // produce (a space, a scheme, a foreign host) is refused here.
  if (team !== "" && normalizeTeamDomain(team) === null) {
    issues.push({
      field: "teamDomain",
      message: "Access team domain should be your team name (myteam) or the full host myteam.cloudflareaccess.com.",
    });
  }
  return issues;
}

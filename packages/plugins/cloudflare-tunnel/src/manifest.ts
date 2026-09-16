import { parseManifest, type SubshellManifest } from "@subshell-ai/plugin-api";
import pkg from "../package.json" with { type: "json" };

/**
 * This package's own `subshell` block, read from its package.json so the
 * manifest has ONE source of truth.
 *
 * A host that installs this plugin at runtime reads package.json off disk; a
 * host that ships it built in imports this. Both must describe the same
 * plugin, and the only way to guarantee that is for them to be the same bytes.
 *
 * It matters most here: `exposure: "public-with-gate"` is the fact that makes
 * the host REFUSE to start this plugin's tunnel with no request guard, and a
 * page prints the install button and the apt-repo step from these bytes on a
 * machine that has never seen `cloudflared`.
 */
const parsed = parseManifest(pkg);
if ("error" in parsed) {
  throw new Error(`@subshell-ai/plugin-cloudflare-tunnel has an invalid manifest: ${parsed.error}`);
}

export const manifest: SubshellManifest = parsed;

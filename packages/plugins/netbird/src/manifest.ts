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
 * It matters more here than for a harness: the `network` block is the ONLY
 * thing a page has before any of this code runs, so "not available on this
 * platform" and the install steps are rendered from these bytes on a machine
 * that has never seen NetBird.
 */
const parsed = parseManifest(pkg);
if ("error" in parsed) throw new Error(`@subshell-ai/plugin-netbird has an invalid manifest: ${parsed.error}`);

export const manifest: SubshellManifest = parsed;

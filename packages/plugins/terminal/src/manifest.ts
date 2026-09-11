import { parseManifest, type SubshellManifest } from "@subshell-ai/plugin-api";
import pkg from "../package.json" with { type: "json" };

/**
 * This package's own `subshell` block, read from its package.json so the
 * manifest has ONE source of truth.
 *
 * A host that installs this plugin at runtime reads package.json off disk; a
 * host that ships it built in imports this. Both must describe the same
 * plugin, and the only way to guarantee that is for them to be the same bytes.
 */
const parsed = parseManifest(pkg);
if ("error" in parsed) throw new Error(`@subshell-ai/plugin-terminal has an invalid manifest: ${parsed.error}`);

export const manifest: SubshellManifest = parsed;

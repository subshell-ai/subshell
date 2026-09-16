import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSecrets } from "@subshell-ai/plugin-api";

/**
 * Where a plugin's own state and credentials live on this host.
 *
 * Separate from `<dataDir>/plugins/`, which holds the plugin's CODE and is
 * replaced wholesale on every upgrade: a credential stored there would be
 * destroyed by an update, and a directory that is both "the package" and "the
 * secrets" cannot have one lifetime. So code is installed and replaced, state
 * persists, and uninstalling is what removes both.
 *
 * Both are 0700 directories holding 0600 files, which is the protection this
 * store actually offers: the same OS user that could read the file can already
 * read `config.env` (holding `BETTER_AUTH_SECRET`) and the node signing key. A
 * stolen data directory is a stolen credential, and encryption keyed from a
 * file beside it would not change that — the designed-but-unbuilt
 * `SUBSHELL_SECRETS_KEY` store (docs/security.md §8) puts the key in the
 * environment for exactly that reason, and this is deliberately not it.
 */

/** Directory mode: only this user may traverse it. */
const DIR_MODE = 0o700;

/** File mode: only this user may read it. */
const FILE_MODE = 0o600;

/**
 * Secret names become file names, so they are single path segments and
 * nothing else — no separators, no traversal, no leading dot.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `<dataDir>/plugins-state/<pluginId>` — one plugin's private corner. */
export function pluginStateDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins-state", pluginId);
}

/** `<dataDir>/plugins-state/<pluginId>/secrets` — where {@link createPluginSecrets} writes. */
export function pluginSecretsDir(dataDir: string, pluginId: string): string {
  return join(pluginStateDir(dataDir, pluginId), "secrets");
}

/**
 * The absolute path a stored secret occupies.
 *
 * Exported for the HOST, never handed to a plugin: it is what the supervisor
 * substitutes into a `--token-file` argument so a credential reaches a child
 * process without ever being an argv element (and so `ps` output). A plugin
 * asking for this would be a plugin able to read the file itself, which is the
 * whole thing {@link PluginSecrets} refuses.
 * @throws when `name` is not a usable file name
 */
export function secretPath(dataDir: string, pluginId: string, name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`"${name}" is not a usable secret name (lowercase letters, digits and hyphens)`);
  }
  return join(pluginSecretsDir(dataDir, pluginId), name);
}

/**
 * Builds the write-only secret store one plugin sees.
 *
 * There is deliberately no `get`. A plugin that could read a credential could
 * put it in an argv, a log line or a status hint, and every legitimate
 * consumer is a process the host spawns — so the host reads it and the plugin
 * only ever names it. `has` exists because a plugin genuinely needs to know
 * whether it is configured, and a boolean discloses nothing a UI would not
 * already be showing.
 * @param dataDir - the server's data directory
 * @param pluginId - whose store this is; each plugin sees only its own
 */
export function createPluginSecrets(dataDir: string, pluginId: string): PluginSecrets {
  return {
    async set(name, value) {
      const target = secretPath(dataDir, pluginId, name);
      await mkdir(pluginSecretsDir(dataDir, pluginId), { recursive: true, mode: DIR_MODE });
      // `mkdir` honours the mode only when it CREATES the directory, and a
      // data dir restored from a backup or created by an older build may carry
      // anything. Repairing it on every write is cheap and is the only moment
      // this code is guaranteed to run.
      await chmod(pluginStateDir(dataDir, pluginId), DIR_MODE);
      await chmod(pluginSecretsDir(dataDir, pluginId), DIR_MODE);
      // Temp + rename, and the mode set BEFORE the rename: a reader that
      // catches the file between `writeFile` and `chmod` would find a
      // credential at the umask's mode, and there is no window here in which
      // the final path exists at the wrong one.
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, value, { mode: FILE_MODE });
      await chmod(temp, FILE_MODE);
      await rename(temp, target);
    },
    async has(name) {
      try {
        await stat(secretPath(dataDir, pluginId, name));
        return true;
      } catch {
        return false;
      }
    },
    async delete(name) {
      // `force` because "it is already gone" is the outcome the caller wanted.
      await rm(secretPath(dataDir, pluginId, name), { force: true });
    },
  };
}

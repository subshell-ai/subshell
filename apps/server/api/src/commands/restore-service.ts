import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnvFile } from "@/config-env.js";
import { type ServiceDeps, type ServiceState, SYSTEMD_UNIT_NAME } from "@/service.js";
import { BACKUP_CONFIG_KEYS } from "@/services/backups/index.js";
import type { InstancePaths } from "@/services/backups/types.js";
import { parseSystemdExec } from "@/services/installed-binary.js";

/** The invocation's config directory is never evidence of the installed service's identity. */
export function installedRestoreServicePaths(state: ServiceState, deps: ServiceDeps): InstancePaths {
  if (!state.installed || !state.definitionPath)
    throw new Error("Cannot prove the installed service's instance paths; stop it explicitly before restoring.");
  const identity =
    deps.platform === "linux"
      ? systemdIdentity(deps)
      : deps.platform === "darwin"
        ? launchdIdentity(state, deps)
        : null;
  if (!identity) throw new Error("Cannot prove the installed service's instance paths on this platform.");
  // homedir()/the invoking ServiceDeps home honor the CLI's HOME override.
  // Supervision's default home is the account home from the OS user database.
  const serviceHome = identity.environment.HOME ?? userInfo().homedir;
  const configDir = resolve(
    identity.environment.SUBSHELL_SERVER_CONFIG_DIR ?? join(serviceHome, ".config", "subshell-server"),
  );
  if (
    !isAbsolute(identity.workingDirectory) ||
    resolve(identity.workingDirectory) !== configDir ||
    (identity.configFile && resolve(identity.configFile) !== join(configDir, "config.env"))
  )
    throw new Error(
      "The installed service's config loader, working directory and config file do not name one instance. Stop it explicitly and correct its configuration before restoring.",
    );
  const configPath = join(configDir, "config.env");
  const config = deps.readFile(configPath);
  if (config === null || Buffer.byteLength(config) > 1024 * 1024)
    throw new Error("Cannot read the installed service's configuration to prove its restore paths.");
  const values = parseEnvFile(config);
  if (deps.fileExists(join(identity.workingDirectory, ".env")))
    throw new Error("The installed service has a cwd .env layer; its effective restore paths cannot be proven.");
  if (values.HOME && resolve(values.HOME) !== resolve(serviceHome))
    throw new Error("The installed service's config file redirects its home directory.");
  if (
    values.SUBSHELL_SERVER_CONFIG_DIR &&
    resolve(identity.workingDirectory, values.SUBSHELL_SERVER_CONFIG_DIR) !== configDir
  )
    throw new Error("The installed service's config file redirects its loader to another instance.");
  // A missing DB setting could be supplied by cwd .env or a runtime default.
  // Restoring cannot prove that precedence without executing the service.
  if (!values.DATABASE_PATH)
    throw new Error(
      "The installed service must name DATABASE_PATH in config.env before automatic restore orchestration.",
    );
  const databasePath = resolve(identity.workingDirectory, values.DATABASE_PATH);
  const dataDir = resolve(identity.workingDirectory, values.SUBSHELL_SERVER_DATA_DIR ?? dirname(databasePath));
  return { databasePath, dataDir, configPath };
}

interface ServiceIdentity {
  workingDirectory: string;
  configFile?: string;
  environment: Record<string, string>;
}

function checkedEnvironment(environment: Record<string, string>): Record<string, string> {
  if (BACKUP_CONFIG_KEYS.some((key) => environment[key] !== undefined))
    throw new Error(
      "The installed service overrides restored settings outside config.env. Stop it explicitly and review those overrides before restoring.",
    );
  if (environment.SUBSHELL_SERVER_CONFIG_DIR && !isAbsolute(environment.SUBSHELL_SERVER_CONFIG_DIR))
    throw new Error("The installed service's config directory override must be absolute.");
  if (environment.HOME && !isAbsolute(environment.HOME))
    throw new Error("The installed service's home directory must be absolute.");
  return environment;
}

function systemdIdentity(deps: ServiceDeps): ServiceIdentity {
  // These are systemd's loaded values, including drop-ins and daemon-reload
  // state. A grep of the definition cannot establish effective ownership.
  const result = deps.runCmd([
    "systemctl",
    "--user",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=WorkingDirectory",
    "--property=EnvironmentFiles",
    "--property=Environment",
  ]);
  if (result.code !== 0)
    throw new Error("Cannot query the installed service's effective paths; stop it explicitly before restoring.");
  const properties: Record<string, string> = {};
  for (const line of result.out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) properties[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const workingDirectory = properties.WorkingDirectory;
  const files = properties.EnvironmentFiles;
  if (!workingDirectory || !files || properties.Environment === undefined)
    throw new Error("The installed service did not report complete effective path metadata.");
  // More than one file, specifier expansion, optional missing files, or an
  // unfamiliar rendering cannot be guessed into an instance identity.
  const configFile = join(workingDirectory, "config.env");
  if (files !== `${configFile} (ignore_errors=no)`)
    throw new Error(
      "The installed service does not load exactly its working directory's config.env; restore ownership is unproven.",
    );
  const inherited = deps.runCmd(["systemctl", "--user", "show-environment"]);
  if (inherited.code !== 0)
    throw new Error("Cannot inspect systemd's inherited environment to prove restore ownership.");
  const environment: Record<string, string> = {};
  for (const entry of inherited.out.split("\n").filter(Boolean)) {
    const parts = parseSystemdExec(entry);
    if (parts.length !== 1) throw new Error("The installed service manager reported an unreadable environment.");
    const value = parts[0] as string;
    const eq = value.indexOf("=");
    if (eq < 1) throw new Error("The installed service manager reported an unreadable environment.");
    environment[value.slice(0, eq)] = value.slice(eq + 1);
  }
  for (const entry of parseSystemdExec(properties.Environment)) {
    const eq = entry.indexOf("=");
    if (eq < 1) throw new Error("The installed service reported an unreadable environment.");
    environment[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return { workingDirectory, configFile, environment: checkedEnvironment(environment) };
}

function launchdIdentity(state: ServiceState, deps: ServiceDeps): ServiceIdentity {
  if (state.state !== "running" && state.loaded !== false)
    throw new Error(
      "The installed launchd job is loaded or its loaded state is unknown. Its disk plist cannot prove the idle job's instance; stop it explicitly before restoring.",
    );
  // plutil handles both the generated XML plist and supported binary plists.
  const result = deps.runCmd(["/usr/bin/plutil", "-convert", "json", "-o", "-", state.definitionPath as string]);
  if (result.code !== 0) throw new Error("Cannot inspect the installed launchd definition to prove restore ownership.");
  let plist: { WorkingDirectory?: unknown; EnvironmentVariables?: unknown };
  try {
    plist = JSON.parse(result.out) as typeof plist;
  } catch {
    throw new Error("The installed launchd definition is unreadable.");
  }
  if (typeof plist.WorkingDirectory !== "string")
    throw new Error("The installed launchd definition has no working directory.");
  const declared = plist.EnvironmentVariables ?? {};
  if (
    !declared ||
    typeof declared !== "object" ||
    Array.isArray(declared) ||
    Object.values(declared).some((value) => typeof value !== "string")
  )
    throw new Error("The installed launchd environment is unreadable.");
  const environment = checkedEnvironment({ ...declared } as Record<string, string>);
  // launchd can also supply values from its per-user environment. Refuse
  // restored-setting overrides rather than silently shadow the restored file.
  for (const key of [...BACKUP_CONFIG_KEYS, "SUBSHELL_SERVER_CONFIG_DIR", "HOME"]) {
    const inherited = deps.runCmd(["launchctl", "getenv", key]);
    if (inherited.code !== 0)
      throw new Error("Cannot inspect launchd's inherited environment to prove restore ownership.");
    const value = inherited.out.replace(/\r?\n$/, "");
    if (!value) continue;
    if (key !== "SUBSHELL_SERVER_CONFIG_DIR" && key !== "HOME")
      throw new Error(
        "launchd overrides restored settings outside config.env. Stop it explicitly and review those overrides before restoring.",
      );
    if (environment[key] === undefined) environment[key] = value;
  }
  return { workingDirectory: plist.WorkingDirectory, environment: checkedEnvironment(environment) };
}

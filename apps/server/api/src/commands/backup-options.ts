import type { RestoreConfigOverrides } from "@/services/backups/types.js";

export interface BackupOpts {
  list?: boolean;
  json?: boolean;
  output?: string;
  encrypt?: boolean;
  passwordFile?: string;
  databaseOnly?: boolean;
}

export interface RestoreOpts {
  archive?: string;
  staged?: string;
  listStaged?: boolean;
  discardStaged?: string;
  prepare?: boolean;
  inspect?: boolean;
  nativePreflight?: boolean;
  native?: boolean;
  json?: boolean;
  mode?: "same-machine" | "migration";
  dataDir?: string;
  databasePath?: string;
  configDir?: string;
  configOverrides?: RestoreConfigOverrides;
  recoverAdmin?: string;
  temporaryPasswordFile?: string;
  passwordFile?: string;
  start?: boolean;
  yes?: boolean;
  force?: boolean;
}

/** Strict allowlists: repeated flags and conflicting choices never silently win. */
export function parseBackupFlags(args: string[], error: (line: string) => void): BackupOpts | null {
  try {
    const { values } = parse(args, ["json", "list", "encrypt", "database-only"], ["output", "password-file"]);
    if (values.list && Object.keys(values).some((key) => !["list", "json"].includes(key)))
      throw new Error("--list accepts only --json");
    const opts: BackupOpts = {
      list: values.list === true,
      json: values.json === true,
      encrypt: values.encrypt === true,
      databaseOnly: values["database-only"] === true,
      output: values.output as string | undefined,
      passwordFile: values["password-file"] as string | undefined,
    };
    if (opts.databaseOnly)
      throw new Error("--database-only is no longer supported; backups are full instance archives");
    return opts;
  } catch (failure) {
    error(`subshell-server: ${message(failure)}`);
    return null;
  }
}

export function parseRestoreFlags(args: string[], error: (line: string) => void): RestoreOpts | null {
  try {
    const { values, positional } = parse(
      args,
      ["inspect", "prepare", "list-staged", "json", "start", "no-start", "yes", "force", "native-preflight", "native"],
      [
        "staged",
        "discard-staged",
        "mode",
        "data-dir",
        "database-path",
        "config-dir",
        "base-url",
        "host",
        "port",
        "trusted-origins",
        "recover-admin",
        "temporary-password-file",
        "password-file",
      ],
      true,
    );
    if (values["discard-staged"]) {
      if (positional.length || Object.keys(values).some((key) => !["discard-staged", "json"].includes(key)))
        throw new Error("--discard-staged accepts only --json");
      return { discardStaged: values["discard-staged"] as string, json: values.json === true };
    }
    if (values["native-preflight"]) {
      if (
        !values.staged ||
        positional.length ||
        Object.keys(values).some((key) => !["staged", "native-preflight", "json", "force"].includes(key))
      )
        throw new Error("--native-preflight accepts only --staged, --json and --force");
      return {
        staged: values.staged as string,
        nativePreflight: true,
        json: values.json === true,
        force: values.force === true,
      };
    }
    if (values.native && (!values.staged || values.inspect || values.prepare))
      throw new Error("--native requires a prepared staged application");
    if (values.prepare && (values.inspect || values.staged || values.yes || values.force || values.start))
      throw new Error("--prepare requires an archive and cannot inspect, replace, or start the destination");
    if (values["list-staged"]) {
      if (positional.length || Object.keys(values).some((key) => !["list-staged", "json"].includes(key)))
        throw new Error("--list-staged accepts only --json");
      return { listStaged: true, json: values.json === true };
    }
    if (positional.length > 1 || !!values.staged === (positional.length === 1))
      throw new Error("restore requires exactly one archive or --staged <UUID>");
    if (values.start && values["no-start"]) throw new Error("--start and --no-start are mutually exclusive");
    if (values.mode !== undefined && values.mode !== "same-machine" && values.mode !== "migration")
      throw new Error("--mode must be same-machine or migration");
    if (values["temporary-password-file"] && !values["recover-admin"])
      throw new Error("--temporary-password-file requires --recover-admin");
    if (values["password-file"] === "-" && values["temporary-password-file"] === "-")
      throw new Error("only one password may use stdin; use a protected file for the other");
    const modifying = [
      "start",
      "no-start",
      "yes",
      "force",
      "recover-admin",
      "temporary-password-file",
      "mode",
      "data-dir",
      "database-path",
      "config-dir",
      "base-url",
      "host",
      "port",
      "trusted-origins",
    ];
    if (values.inspect && modifying.some((key) => values[key] !== undefined))
      throw new Error("--inspect cannot be combined with restore choices or replacement flags");
    if (
      values.staged &&
      [
        "password-file",
        "recover-admin",
        "temporary-password-file",
        "mode",
        "base-url",
        "host",
        "port",
        "trusted-origins",
      ].some((key) => values[key] !== undefined)
    )
      throw new Error("a staged restore uses its prepared choices; inspect it or prepare another upload");
    const configOverrides: RestoreConfigOverrides = {};
    for (const [flag, key] of [
      ["base-url", "baseUrl"],
      ["host", "host"],
      ["port", "port"],
      ["trusted-origins", "trustedOrigins"],
    ] as const)
      if (values[flag] !== undefined) configOverrides[key] = values[flag] as string;
    return {
      archive: positional[0],
      staged: values.staged as string | undefined,
      inspect: values.inspect === true,
      native: values.native === true,
      prepare: values.prepare === true,
      json: values.json === true,
      mode: values.mode as RestoreOpts["mode"],
      dataDir: values["data-dir"] as string | undefined,
      databasePath: values["database-path"] as string | undefined,
      configDir: values["config-dir"] as string | undefined,
      configOverrides,
      recoverAdmin: values["recover-admin"] as string | undefined,
      temporaryPasswordFile: values["temporary-password-file"] as string | undefined,
      passwordFile: values["password-file"] as string | undefined,
      start: values.start ? true : values["no-start"] ? false : undefined,
      yes: values.yes === true,
      force: values.force === true,
    };
  } catch (failure) {
    error(`subshell-server: ${message(failure)}`);
    return null;
  }
}

function parse(args: string[], booleans: string[], strings: string[], allowPositional = false) {
  const values: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      if (allowPositional && !arg.startsWith("-")) {
        positional.push(arg);
        continue;
      }
      throw new Error(`unexpected argument '${arg}'`);
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    if (values[key] !== undefined) throw new Error(`repeated flag --${key}`);
    if (booleans.includes(key) && eq < 0) {
      values[key] = true;
      continue;
    }
    if (!strings.includes(key)) throw new Error(`unexpected argument '${arg}'`);
    const value = eq < 0 ? args[++index] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith("--") || (value === "" && key !== "trusted-origins"))
      throw new Error(`--${key} requires a value`);
    values[key] = value;
  }
  return { values, positional };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { installedRestoreServicePaths } from "@/commands/restore-service.js";
import { DEFAULT_DEPS, type ServiceDeps, type ServiceState } from "@/service.js";

const home = "/tmp/restore-service-owner-fixture";
const configured = join(home, ".config", "subshell-server");
const state: ServiceState = {
  installed: true,
  loaded: false,
  definitionPath: join(home, ".config", "systemd", "user", "subshell-server.service"),
  state: "stopped",
  pid: null,
  enabled: true,
  linger: null,
  paneSafety: "keeps",
  detail: "",
};
function systemd(
  working = configured,
  environment = "",
  config = "DATABASE_PATH=./plane.db\nSUBSHELL_SERVER_DATA_DIR=./state\n",
): ServiceDeps {
  const deps = DEFAULT_DEPS({
    platform: "linux",
    home,
    uid: 1000,
    servicePath: "/tmp/server",
    argv1: "",
    configDir: "/tmp/invoking-other-instance",
    env: {},
    which: () => null,
  });
  deps.runCmd = (argv) => ({
    code: 0,
    out: argv.includes("show-environment")
      ? `HOME=${home}\n`
      : `WorkingDirectory=${working}\nEnvironmentFiles=${working}/config.env (ignore_errors=no)\nEnvironment=${environment}\n`,
    err: "",
  });
  deps.readFile = () => config;
  deps.fileExists = () => false;
  return deps;
}

describe("restore installed service ownership proof", () => {
  test("effective systemd configuration wins over the invoking CLI config directory", () => {
    const deps = systemd();
    expect(installedRestoreServicePaths(state, deps)).toEqual({
      configPath: join(configured, "config.env"),
      databasePath: join(configured, "plane.db"),
      dataDir: join(configured, "state"),
    });
  });
  test("unrelated shell-quoted manager values do not block restore ownership checks", () => {
    const deps = systemd();
    const run = deps.runCmd;
    deps.runCmd = (argv) =>
      argv.includes("show-environment")
        ? {
            code: 0,
            out: `HOME='${home}'\nDEBUGINFOD_URLS='https://debug.example.test/ https://symbols.example.test/'\nDESKTOP_LABEL=$'multi\\nline'\n`,
            err: "",
          }
        : run(argv);
    expect(installedRestoreServicePaths(state, deps).databasePath).toBe(join(configured, "plane.db"));
    deps.runCmd = (argv) =>
      argv.includes("show-environment")
        ? {
            code: 0,
            out: `HOME='${home}'\nDATABASE_PATH='/tmp/another database.db'\n`,
            err: "",
          }
        : run(argv);
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("outside config.env");
  });
  test("custom working directory without a matching loader override is refused", () => {
    expect(() => installedRestoreServicePaths(state, systemd("/tmp/custom-plane"))).toThrow("do not name one instance");
    expect(
      installedRestoreServicePaths(state, systemd("/tmp/custom-plane", "SUBSHELL_SERVER_CONFIG_DIR=/tmp/custom-plane")),
    ).toMatchObject({ configPath: "/tmp/custom-plane/config.env", databasePath: "/tmp/custom-plane/plane.db" });
  });
  test("inherited manager paths and cwd dotenv cannot silently redirect service ownership", () => {
    const deps = systemd();
    const run = deps.runCmd;
    deps.runCmd = (argv) =>
      argv.includes("show-environment")
        ? { code: 0, out: "SUBSHELL_SERVER_CONFIG_DIR=/tmp/inherited-plane\n", err: "" }
        : run(argv);
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("do not name one instance");
    deps.runCmd = (argv) =>
      argv.includes("show-environment") ? { code: 0, out: "HOME=/tmp/inherited-home\n", err: "" } : run(argv);
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("do not name one instance");
    deps.runCmd = run;
    deps.fileExists = (path) => path === join(configured, ".env");
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("cwd .env layer");
  });
  test("loaded drop-in state, incomplete metadata and static settings overrides are never guessed", () => {
    const deps = systemd();
    deps.runCmd = () => ({
      code: 0,
      out: `WorkingDirectory=${configured}\nEnvironmentFiles=/tmp/another/config.env (ignore_errors=no)\nEnvironment=\n`,
      err: "",
    });
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("ownership is unproven");
    deps.runCmd = () => ({ code: 1, out: "", err: "manager unavailable" });
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("Cannot query");
    expect(() => installedRestoreServicePaths(state, systemd(configured, "DATABASE_PATH=/tmp/env-shadow.db"))).toThrow(
      "outside config.env",
    );
    expect(() => installedRestoreServicePaths(state, systemd(configured, "", "HOST=127.0.0.1\n"))).toThrow(
      "must name DATABASE_PATH",
    );
  });
  test("launchd uses plist and inherited environment rather than the invoking config seed", () => {
    const deps = systemd();
    deps.platform = "darwin";
    deps.runCmd = (argv) =>
      argv[0] === "/usr/bin/plutil"
        ? {
            code: 0,
            out: JSON.stringify({ WorkingDirectory: configured, EnvironmentVariables: { PATH: "/usr/bin" } }),
            err: "",
          }
        : { code: 0, out: argv[2] === "HOME" ? `${home}\n` : "", err: "" };
    expect(installedRestoreServicePaths(state, deps)).toMatchObject({ configPath: join(configured, "config.env") });
    expect(() => installedRestoreServicePaths({ ...state, loaded: true }, deps)).toThrow("disk plist cannot prove");
    deps.runCmd = (argv) =>
      argv[0] === "/usr/bin/plutil"
        ? { code: 0, out: JSON.stringify({ WorkingDirectory: "/tmp/custom-plane", EnvironmentVariables: {} }), err: "" }
        : { code: 0, out: argv[2] === "SUBSHELL_SERVER_CONFIG_DIR" ? "/tmp/custom-plane\n" : "", err: "" };
    expect(installedRestoreServicePaths(state, deps)).toMatchObject({ configPath: "/tmp/custom-plane/config.env" });
    deps.runCmd = (argv) =>
      argv[0] === "/usr/bin/plutil"
        ? { code: 0, out: JSON.stringify({ WorkingDirectory: configured, EnvironmentVariables: {} }), err: "" }
        : { code: 0, out: argv[2] === "BETTER_AUTH_SECRET" ? "must-not-log\n" : "", err: "" };
    expect(() => installedRestoreServicePaths(state, deps)).toThrow("outside config.env");
  });
});

import { describe, expect, it } from "bun:test";
import { appSupervised, collectDeployment, isSupervised, settingSource } from "@/services/server-deployment.js";

describe("isSupervised", () => {
  it("is true only when the manager reports this very pid as running", () => {
    expect(isSupervised({ state: "running", pid: 4242 }, 4242)).toBe(true);
    expect(isSupervised({ state: "running", pid: 4243 }, 4242)).toBe(false);
    expect(isSupervised({ state: "stopped", pid: 4242 }, 4242)).toBe(false);
    expect(isSupervised({ state: "running", pid: null }, 4242)).toBe(false);
  });
});

describe("settingSource", () => {
  it("attributes a key the loader applied to config.env even though process.env now holds it", () => {
    expect(settingSource("HOST", { HOST: "0.0.0.0" }, new Set(["HOST"]))).toBe("config.env");
  });
  it("attributes a key present in the environment but not applied to the process env", () => {
    expect(settingSource("HOST", { HOST: "0.0.0.0" }, new Set())).toBe("process env");
  });
  it("attributes an absent key to the default", () => {
    expect(settingSource("HOST", {}, new Set())).toBe("default");
  });

  /**
   * The systemd deployment, which the applied-key rule alone gets wrong. The
   * unit carries `EnvironmentFile=<configDir>/config.env`, so every key is in
   * the environment before the process starts and the loader applies NONE of
   * them — yet systemd re-reads that file on the next start, so writing it
   * plainly does take effect. Without this the PATCH route would 409 on every
   * key of every systemd install.
   */
  it("attributes a key the environment and the file agree on to config.env, applied or not", () => {
    expect(settingSource("HOST", { HOST: "0.0.0.0" }, new Set(), { HOST: "0.0.0.0" })).toBe("config.env");
  });
  it("still attributes a genuine override to the process env", () => {
    expect(settingSource("HOST", { HOST: "127.0.0.1" }, new Set(), { HOST: "0.0.0.0" })).toBe("process env");
  });
  it("attributes a key only the file names to config.env", () => {
    expect(settingSource("HOST", {}, new Set(), { HOST: "0.0.0.0" })).toBe("config.env");
  });
});

describe("collectDeployment", () => {
  const service = {
    installed: true,
    definitionPath: "/u/.config/systemd/user/subshell-server.service",
    state: "running",
    pid: 777,
    enabled: true,
    paneSafety: "keeps",
    detail: "",
    logPath: null,
  } as const;

  it("marks restartRequired when a saved value differs from the running one, and reports supervision from the pid", () => {
    const view = collectDeployment({
      platform: "linux",
      pid: 777,
      env: { ...process.env, TRUSTED_ORIGINS: undefined },
      applied: new Set(),
      queryService: () => service as never,
    });
    expect(view.service.supervised).toBe(true);
    expect(view.restart.available).toBe(true);
    expect(view.service.logHint).toContain("journalctl");
    expect(typeof view.restartRequired).toBe("boolean");
    expect(Object.keys(view.settings)).toEqual([
      "SERVER_PORT",
      "HOST",
      "APP_BASE_URL",
      "DATABASE_PATH",
      "TRUSTED_ORIGINS",
    ]);
    expect(view.paths.serverLog.endsWith("/logs/server.log")).toBe(true);
    expect(view.logging).toEqual({ debug: false, source: "default", file: view.paths.serverLog, capBytes: 204_800 });
  });

  it("names the reason when not supervised", () => {
    const view = collectDeployment({
      platform: "linux",
      pid: 1,
      applied: new Set(),
      queryService: () => service as never,
    });
    expect(view.restart.available).toBe(false);
    expect(view.restart.reason).toContain("service manager");
  });

  it("carries no secret in any form", () => {
    const view = collectDeployment({ platform: "linux", applied: new Set(), queryService: () => service as never });
    expect(["set", "missing"]).toContain(view.authSecret.state);
    expect(JSON.stringify(view)).not.toContain("BETTER_AUTH_SECRET=");
  });
});

/**
 * The desktop app as a supervisor (spec 2026-09-12 server-supervision § 4.7).
 *
 * The app runs the server as a child when the operator asked for that instead
 * of a launchd/systemd service. It tells the server so through the
 * environment, and the server checks the claim against its own parent before
 * believing it.
 */
describe("appSupervised", () => {
  const OK = { SUBSHELL_SUPERVISOR: "subshell-desktop-server", SUBSHELL_SUPERVISOR_PID: "900" };

  it("is true only when the claim AND the parentage agree", () => {
    expect(appSupervised(OK, 900)).toBe(true);
    // A claim from something that is not our parent is a claim anyone could
    // make; parentage is what makes it evidence.
    expect(appSupervised(OK, 901)).toBe(false);
    expect(appSupervised({ ...OK, SUBSHELL_SUPERVISOR: "something-else" }, 900)).toBe(false);
    expect(appSupervised({}, 900)).toBe(false);
    expect(appSupervised({ SUBSHELL_SUPERVISOR: "subshell-desktop-server" }, 900)).toBe(false);
  });

  it("does not accept a non-numeric pid claim", () => {
    expect(appSupervised({ ...OK, SUBSHELL_SUPERVISOR_PID: "nine hundred" }, 900)).toBe(false);
  });
});

describe("collectDeployment under the app", () => {
  const notInstalled = {
    installed: false,
    definitionPath: "/home/t/.config/systemd/user/subshell-server.service",
    state: "not-installed",
    pid: null,
    enabled: null,
    paneSafety: null,
    detail: "",
    logPath: null,
  } as const;

  it("reports the app as the manager, supervised, and restartable", () => {
    const view = collectDeployment({
      platform: "linux",
      pid: 4242,
      applied: new Set(),
      queryService: () => notInstalled as never,
      appSupervised: () => true,
      env: { ...process.env, SUBSHELL_SUPERVISOR_LOG: "/home/t/.local/state/subshell-server/console.log" },
    });
    expect(view.service.manager).toBe("app");
    expect(view.service.pid).toBe(4242);
    expect(view.service.state).toBe("running");
    // Restart works here for a real reason: the app respawns this process on
    // exit exactly as a manager does, which is all `available` ever meant.
    expect(view.service.supervised).toBe(true);
    expect(view.restart.available).toBe(true);
    expect(view.restart.reason).toBe(null);
    // Earned by the supervisor signalling the main pid only.
    expect(view.service.paneSafety).toBe("keeps");
    // Nothing starts the app's child at login; the app starting at login is a
    // different feature, and the switch is disabled with that reason.
    expect(view.service.enabled).toBe(false);
    expect(view.service.logPath).toBe("/home/t/.local/state/subshell-server/console.log");
    expect(view.service.logHint).toBe(null);
  });

  it("still names a definition on disk, because two owners is a real conflict", () => {
    const installed = { ...notInstalled, installed: true } as const;
    const view = collectDeployment({
      platform: "linux",
      pid: 4242,
      applied: new Set(),
      queryService: () => installed as never,
      appSupervised: () => true,
    });
    expect(view.service.manager).toBe("app");
    // Hiding this would leave an operator with a service they believe is gone
    // and a server that comes back twice at the next login.
    expect(view.service.installed).toBe(true);
    expect(view.service.definitionPath).toContain("subshell-server.service");
  });

  it("keeps every deployment fact that does not depend on the supervisor", () => {
    const byApp = collectDeployment({
      platform: "linux",
      pid: 4242,
      applied: new Set(),
      queryService: () => notInstalled as never,
      appSupervised: () => true,
    });
    const byManager = collectDeployment({
      platform: "linux",
      pid: 4242,
      applied: new Set(),
      queryService: () => notInstalled as never,
      appSupervised: () => false,
    });
    // One `base` object feeds both branches, so a field added later cannot
    // reach only one of them.
    expect(Object.keys(byApp).sort()).toEqual(Object.keys(byManager).sort());
    expect(byApp.settings).toEqual(byManager.settings);
    expect(byApp.paths).toEqual(byManager.paths);
  });
});

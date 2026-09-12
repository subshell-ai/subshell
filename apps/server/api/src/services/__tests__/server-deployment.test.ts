import { describe, expect, it } from "bun:test";
import { collectDeployment, isSupervised, settingSource } from "@/services/server-deployment.js";

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

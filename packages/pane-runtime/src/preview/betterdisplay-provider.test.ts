import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BetterDisplayProvider } from "./betterdisplay-provider.js";
import type { HelperStatus } from "./macos-helper.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const pane = "12345678-1234-4234-8234-123456789012";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "betterdisplay-test-"));
  temporary.push(directory);
  let status: HelperStatus | null = {
    enabled: true,
    screenRecording: true,
    accessibility: true,
    betterDisplayExecutable: "/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay",
  };
  const physical = { name: "Laptop", UUID: "physical", deviceType: "Display" };
  let display: Record<string, string> | undefined;
  const calls: string[][] = [];
  let failedCreate = false;
  let stopCount = 0;
  let rescues = 0;
  const bridge = {
    port: 5922,
    start: async () => {},
    stop: () => {
      stopCount++;
    },
    onLost: undefined as (() => void) | undefined,
  };
  const deps = {
    platform: "darwin",
    kernelRelease: "23.0.0",
    status: async () => status,
    alive: () => false,
    rescue: async () => {
      rescues++;
    },
    bridge: () => bridge,
    run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "get") return JSON.stringify(physical) + (display ? `,${JSON.stringify(display)}` : "");
      if (args[0] === "create") {
        if (failedCreate) throw new Error("BetterDisplay timeout");
        display = {
          name: args.find((a) => a.startsWith("-virtualScreenName="))?.split("=")[1] ?? "missing",
          UUID: "abcdef01-2345-4567-89ab-abcdef012345",
          tagID: "42",
          displayID: "99",
          deviceType: "VirtualScreen",
        };
      }
      if (args[0] === "discard") {
        expect(args).toContain("-tagID=42");
        expect(args.some((a) => a.startsWith("-name=Subshell-"))).toBe(true);
        display = undefined;
      }
      return "Success.";
    },
  };
  return {
    directory,
    deps,
    calls,
    bridge,
    provider: new BetterDisplayProvider(directory, deps),
    setStatus(value: HelperStatus | null) {
      status = value;
    },
    failCreation() {
      failedCreate = true;
    },
    allowCreation() {
      failedCreate = false;
    },
    disappear() {
      display = undefined;
    },
    appear(name: string) {
      display = {
        name,
        UUID: "abcdef01-2345-4567-89ab-abcdef012345",
        tagID: "42",
        displayID: "99",
        deviceType: "VirtualScreen",
      };
    },
    changeIdentity() {
      if (display) display.tagID = "43";
    },
    uppercaseUUID() {
      if (display) display.UUID = display.UUID.toUpperCase();
    },
    get stops() {
      return stopCount;
    },
    get rescueCount() {
      return rescues;
    },
  };
}

test("a disabled or absent helper is read-only and cannot allocate", async () => {
  const f = fixture();
  f.setStatus(null);
  expect((await f.provider.readiness()).missing[0]).toContain("Enable Virtual Display Helper");
  await expect(f.provider.openFor(pane, { width: 1280, height: 800 })).rejects.toThrow("missing-requirements");
  expect(f.calls).toEqual([]);
  expect(readdirSync(f.directory)).toEqual([]);
});
test("permissions and BetterDisplay are independently reported", async () => {
  const f = fixture();
  f.setStatus({ enabled: true, screenRecording: false, accessibility: false, betterDisplayExecutable: null });
  expect((await f.provider.readiness()).missing).toHaveLength(3);
  expect(f.calls).toEqual([]);
});
test("allocation pins identity and removes only the owned display", async () => {
  const f = fixture();
  const screen = await f.provider.openFor(pane, { width: 1280, height: 800 });
  expect(screen.viewer).toEqual({ protocol: "vnc", port: 5922 });
  expect(f.provider.launchEnv(pane).SUBSHELL_DISPLAY_UUID).toBe(screen.display);
  expect(f.calls.find((args) => args[0] === "create")).toContain("-resolutionList=1280x800");
  await f.provider.closeFor(pane);
  expect(f.stops).toBe(1);
  expect(f.provider.getFor(pane)).toBeNull();
  expect(readdirSync(join(f.directory, "betterdisplay-displays"))).toEqual([]);
});
test("changed identity never reaches discard and keeps the recovery journal", async () => {
  const f = fixture();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  f.changeIdentity();
  await expect(f.provider.closeFor(pane)).rejects.toThrow("identity changed");
  expect(f.calls.some((args) => args[0] === "discard")).toBe(false);
  expect(readdirSync(join(f.directory, "betterdisplay-displays", pane))).toContain("display.json");
});
test("uncertain creation keeps its journal for late BetterDisplay completion", async () => {
  const f = fixture();
  f.failCreation();
  await expect(f.provider.openFor(pane, { width: 1280, height: 800 })).rejects.toThrow("timeout");
  expect(readdirSync(join(f.directory, "betterdisplay-displays"))).toEqual([]);
  const pending = join(f.directory, "betterdisplay-displays-pending");
  const [id] = readdirSync(pending);
  if (!id) throw new Error("Missing delayed creation journal");
  const journal = JSON.parse(readFileSync(join(pending, id, "display.json"), "utf8"));
  await f.provider.closeFor(pane);
  f.allowCreation();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  await f.provider.closeFor(pane);
  f.appear(journal.name);
  await f.provider.sweepOrphans([]);
  expect(readdirSync(pending)).toEqual([]);
});
test("helper disconnect removes the viewer without killing the subshell", async () => {
  const f = fixture();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  f.bridge.onLost?.();
  expect(f.provider.getFor(pane)).toBeNull();
  expect(f.provider.lostFor(pane)).toContain("helper");
  await f.provider.closeFor(pane);
});
test("recovery attaches only after verifying the persisted identity", async () => {
  const f = fixture();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  const journalPath = join(f.directory, "betterdisplay-displays", pane, "display.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.pid = 99999;
  writeFileSync(journalPath, JSON.stringify(journal));
  const recovered = new BetterDisplayProvider(f.directory, f.deps);
  expect((await recovered.sweepOrphans([pane])).rehydrated).toBe(1);
  expect(recovered.getFor(pane)?.display).toBe(journal.display.UUID);
  await recovered.closeFor(pane);
});
test("recovery accepts equivalent UUID casing without creating another display", async () => {
  const f = fixture();
  const screen = await f.provider.openFor(pane, { width: 1280, height: 800 });
  f.uppercaseUUID();
  const recovered = new BetterDisplayProvider(f.directory, f.deps);
  expect((await recovered.sweepOrphans([pane])).rehydrated).toBe(1);
  expect(recovered.getFor(pane)?.display.toLowerCase()).toBe(screen.display.toLowerCase());
  expect(f.calls.filter((args) => args[0] === "create")).toHaveLength(1);
  await recovered.closeFor(pane);
});
test("unsupported hosts do not inspect the helper or filesystem", async () => {
  const f = fixture();
  const p = new BetterDisplayProvider(f.directory, {
    ...f.deps,
    platform: "linux",
    status: async () => {
      throw new Error("must not query");
    },
  });
  expect(await p.readiness()).toEqual({ supported: false, missing: [] });
  expect(await p.sweepOrphans([])).toEqual({ reaped: 0, rehydrated: 0, locksFreed: 0 });
});

test("closing waits for allocation before removing its owned display", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.bridge.start = async () => {
    entered.resolve();
    await resume.promise;
  };
  const allocation = f.provider.openFor(pane, { width: 1280, height: 800 });
  await entered.promise;
  const closed = f.provider.closeFor(pane);
  expect(f.stops).toBe(0);
  resume.resolve();
  await allocation;
  await closed;
  expect(f.stops).toBe(1);
  expect(f.provider.getFor(pane)).toBeNull();
  expect(readdirSync(join(f.directory, "betterdisplay-displays"))).toEqual([]);
});

test("recovery reports a vanished display, removes its stale journal, and allows retry", async () => {
  const f = fixture();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  f.disappear();
  const recovered = new BetterDisplayProvider(f.directory, f.deps);
  expect((await recovered.sweepOrphans([pane])).reaped).toBe(1);
  expect(recovered.lostFor(pane)).toContain("no longer available");
  expect(readdirSync(join(f.directory, "betterdisplay-displays"))).toEqual([]);
  await recovered.openFor(pane, { width: 1280, height: 800 });
  expect(recovered.lostFor(pane)).toBeNull();
  await recovered.closeFor(pane);
});

test("allocation reuses its readiness status without a second helper handshake", async () => {
  const f = fixture();
  const status = f.deps.status;
  let probes = 0;
  f.deps.status = async () => {
    probes++;
    return status();
  };
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  expect(probes).toBe(1);
  await f.provider.closeFor(pane);
});

test("discarding the display hands the pointer back to the person at the Mac", async () => {
  // A viewer's pointer lives on the screen being discarded, so the teardown
  // must ask the helper to put it back on a visible display (measured on the
  // M5: the local user lost their cursor entirely).
  const f = fixture();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  expect(f.rescueCount).toBe(0);
  await f.provider.closeFor(pane);
  expect(f.rescueCount).toBe(1);
});

test("a display that vanished under a viewer still gets the pointer rescued", async () => {
  // The screen is already gone, which is precisely when the local cursor can
  // be stranded on it, so the ask happens even though there is nothing left
  // to discard.
  const f = fixture();
  await f.provider.openFor(pane, { width: 1280, height: 800 });
  f.disappear();
  await f.provider.closeFor(pane);
  expect(f.rescueCount).toBe(1);
});

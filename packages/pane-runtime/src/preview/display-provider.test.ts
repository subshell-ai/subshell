import { describe, expect, it } from "bun:test";
import { type PreviewDisplayReadiness, VIRTUAL_DISPLAY_PROVIDERS } from "@internal/subshell-protocol";
import {
  createDisplayProviders,
  PreviewDisplays,
  type PreviewScreenHandle,
  type VirtualDisplayProvider,
} from "./display.js";

class ExampleProvider implements VirtualDisplayProvider {
  screens = new Map<string, PreviewScreenHandle>();
  requirements: PreviewDisplayReadiness = { supported: true, missing: [] };
  allocations = 0;
  sweeps: string[][] = [];
  closed: string[] = [];
  constructor(
    readonly id: string,
    readonly port: number,
  ) {}
  readiness(): PreviewDisplayReadiness | Promise<PreviewDisplayReadiness> {
    return this.requirements;
  }
  getFor(id: string) {
    return this.screens.get(id) ?? null;
  }
  async openFor(id: string) {
    this.allocations++;
    const screen: PreviewScreenHandle = { display: `${this.id}-monitor`, viewer: { protocol: "vnc", port: this.port } };
    this.screens.set(id, screen);
    return screen;
  }
  launchEnv() {
    return { NATIVE_DISPLAY_TOKEN: `${this.id}-private-launch-token` };
  }
  lostFor() {
    return null;
  }
  closeFor(id: string) {
    this.closed.push(id);
    this.screens.delete(id);
  }
  async sweepOrphans(ids: string[]) {
    this.sweeps.push(ids);
    return { reaped: 0, rehydrated: 1, locksFreed: 0 };
  }
}
const size = { width: 1280, height: 800 };

describe("display provider contract", () => {
  it("refuses policy revoked while asynchronous readiness is pending", async () => {
    for (const permission of ["feature", "provider"] as const) {
      const provider = new ExampleProvider("example", 6000);
      const entered = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<PreviewDisplayReadiness>();
      let enabled = true;
      let allowed = [provider.id];
      provider.readiness = () => {
        entered.resolve();
        return ready.promise;
      };
      const displays = new PreviewDisplays("/unused", {
        provider,
        isEnabled: () => enabled,
        getEnabledProviderIds: () => allowed,
      });
      const pending = displays.openFor(crypto.randomUUID(), size);
      const result = pending.catch((error: unknown) => error);
      await entered.promise;
      if (permission === "feature") enabled = false;
      else allowed = [];
      ready.resolve({ supported: true, missing: [] });
      expect(await result).toBeInstanceOf(Error);
      expect(String(await result)).toContain(permission === "feature" ? "preview-node-off" : "provider-disabled");
      expect(provider.allocations).toBe(0);
    }
  });

  it("revoked policy tears down a pending new display but preserves an existing one", async () => {
    for (const permission of ["feature", "provider"] as const) {
      for (const existing of [false, true]) {
        const provider = new ExampleProvider("example", 6000);
        const id = crypto.randomUUID();
        if (existing) await provider.openFor(id);
        let enabled = true;
        let allowed = [provider.id];
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const open = provider.openFor.bind(provider);
        provider.openFor = async (paneId) => {
          entered.resolve();
          await release.promise;
          return open(paneId);
        };
        const displays = new PreviewDisplays("/unused", {
          provider,
          isEnabled: () => enabled,
          getEnabledProviderIds: () => allowed,
        });
        const pending = displays.openFor(id, size).catch((error: unknown) => error);
        await entered.promise;
        if (permission === "feature") enabled = false;
        else allowed = [];
        release.resolve();
        expect(String(await pending)).toContain(permission === "feature" ? "preview-node-off" : "provider-disabled");
        expect(provider.closed).toEqual(existing ? [] : [id]);
        expect(displays.getFor(id) !== null).toBe(existing);
      }
    }
  });

  it("orders competing providers and cleanup behind an in-flight allocation", async () => {
    const first = new ExampleProvider("first", 6001);
    const second = new ExampleProvider("second", 6002);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const open = first.openFor.bind(first);
    first.openFor = async (id: string) => {
      entered.resolve();
      await release.promise;
      return open(id);
    };
    const displays = new PreviewDisplays("/unused", { providers: [first, second], isEnabled: () => true });
    const id = crypto.randomUUID();
    const pending = displays.openFor(id, { ...size, provider: first.id });
    await entered.promise;
    const competing = displays.openFor(id, { ...size, provider: second.id });
    const result = competing.catch((error: unknown) => error);
    const close = displays.closeFor(id);
    release.resolve();
    await pending;
    expect(String(await result)).toContain("provider-conflict");
    await close;
    expect(second.allocations).toBe(0);
    expect(displays.getFor(id)).toBeNull();
  });
  it("uses provider launch settings without putting credentials on the wire", async () => {
    const provider = new ExampleProvider("native-example", 6000);
    const displays = new PreviewDisplays("/unused", { provider, isEnabled: () => true });
    const id = crypto.randomUUID();
    const screen = await displays.openFor(id, size);
    expect(screen.display).toBe("native-example-monitor");
    expect(displays.launchEnv(id)).toEqual({ NATIVE_DISPLAY_TOKEN: "native-example-private-launch-token" });
    expect(JSON.stringify(screen)).not.toContain("token");
    expect(displays.launchEnv(id)).not.toHaveProperty("DISPLAY");
  });
  it("uses the selected provider for new allocations and preserves existing owners", async () => {
    const first = new ExampleProvider("first", 6001);
    const second = new ExampleProvider("second", 6002);
    let selected = first.id;
    let enabled = true;
    const displays = new PreviewDisplays("/unused", {
      providers: [first, second],
      getProviderId: () => selected,
      isEnabled: () => enabled,
    });
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await displays.openFor(a, size);
    selected = second.id;
    await displays.openFor(b, size);
    expect(displays.getFor(a)?.viewer.port).toBe(6001);
    expect(displays.getFor(b)?.viewer.port).toBe(6002);
    expect(displays.launchEnv(a).NATIVE_DISPLAY_TOKEN).toContain("first");
    second.requirements = { supported: true, missing: ["Screen recording permission"] };
    expect(await displays.readiness()).toEqual(second.requirements);
    await expect(displays.openFor(crypto.randomUUID(), size)).rejects.toThrow("Screen recording permission");
    expect(second.allocations).toBe(1);
    await displays.sweepOrphans([a, b]);
    expect(first.sweeps).toEqual([[a, b]]);
    expect(second.sweeps).toEqual([[a, b]]);
    enabled = false;
    await expect(displays.openFor(a, size)).rejects.toThrow("preview-node-off");
    await displays.closeFor(a);
    await displays.closeFor(b);
    expect(displays.getFor(a)).toBeNull();
    expect(displays.getFor(b)).toBeNull();
  });
  it("allows per-subshell choices while enforcing live provider policy", async () => {
    const first = new ExampleProvider("first", 6001);
    const second = new ExampleProvider("second", 6002);
    let allowed = [first.id, second.id];
    const displays = new PreviewDisplays("/unused", {
      providers: [first, second],
      getProviderId: () => first.id,
      getEnabledProviderIds: () => allowed,
      isEnabled: () => true,
    });
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await displays.openFor(a, { ...size, provider: second.id });
    await displays.openFor(b, size);
    expect(displays.getFor(a)?.viewer.port).toBe(6002);
    expect(displays.getFor(b)?.viewer.port).toBe(6001);
    second.requirements = { supported: true, missing: ["Permission"] };
    expect(await displays.readiness(second.id)).toEqual(second.requirements);
    expect(await displays.readiness()).toEqual(first.requirements);
    await expect(displays.openFor(a, { ...size, provider: first.id })).rejects.toThrow("provider-conflict");
    allowed = [first.id];
    await expect(displays.openFor(crypto.randomUUID(), { ...size, provider: second.id })).rejects.toThrow(
      "provider-disabled",
    );
    expect(second.allocations).toBe(1);
    expect(displays.getFor(a)).not.toBeNull();
    await displays.closeFor(a);
    expect(displays.getFor(a)).toBeNull();
    await expect(displays.openFor(crypto.randomUUID(), { ...size, provider: "unknown" })).rejects.toThrow(
      "preview-display-unsupported",
    );
    expect(first.allocations).toBe(1);
  });
  it("refuses unknown providers without falling back to another backend", async () => {
    const provider = new ExampleProvider("example", 6000);
    const displays = new PreviewDisplays("/unused", {
      provider,
      getProviderId: () => "not-installed",
      isEnabled: () => true,
    });
    expect(await displays.readiness()).toEqual({ supported: false, missing: [] });
    await expect(displays.openFor(crypto.randomUUID(), size)).rejects.toThrow("preview-display-unsupported");
    expect(provider.allocations).toBe(0);
  });
});

it("registers every selectable provider exactly once", () => {
  expect(
    createDisplayProviders("/unused")
      .map((p) => p.id)
      .sort(),
  ).toEqual(VIRTUAL_DISPLAY_PROVIDERS.map((p) => p.id).sort());
});

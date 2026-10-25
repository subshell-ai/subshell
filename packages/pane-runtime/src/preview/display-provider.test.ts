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
  readiness() {
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

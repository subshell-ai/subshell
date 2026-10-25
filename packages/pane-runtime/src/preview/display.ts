import {
  DEFAULT_VIRTUAL_DISPLAY_PROVIDER,
  isNodeSubshellId,
  type PreviewDisplayReadiness,
  type VirtualDisplayRequest,
} from "@internal/subshell-protocol";
import {
  PREVIEW_DISPLAY_MISSING_REQUIREMENTS,
  PREVIEW_DISPLAY_NOT_READY,
  PREVIEW_DISPLAY_UNSUPPORTED,
  type VirtualDisplayProvider,
  type VirtualDisplayRuntime,
} from "./display-provider.js";
import { XvfbDisplayProvider } from "./xvfb-display-provider.js";

export * from "./display-provider.js";

export interface PreviewDisplayOptions {
  /** Live node permission, checked on every allocation including existing displays. */
  isEnabled?: () => boolean | Promise<boolean>;
  /** Host-owned diagnostic sink. */
  log?: (line: string) => void;
  /** Override the built-in backend without changing launchers or transports. */
  provider?: VirtualDisplayProvider;
  /** Additional backends, including ones with resources to recover after a switch. */
  providers?: VirtualDisplayProvider[];
  /** Live selection from the server DB or the node's signed settings mirror. */
  getProviderId?: () => string | Promise<string>;
  getEnabledProviderIds?: () => string[] | Promise<string[]>;
}

/** Select built-ins here; providers are statically bundled, not runtime plugins. */
export function createDisplayProviders(dataDir: string, log?: (line: string) => void): VirtualDisplayProvider[] {
  return [new XvfbDisplayProvider(dataDir, { log })];
}

/** Applies host policy around a provider without depending on its display system. */
export class PreviewDisplays implements VirtualDisplayRuntime {
  private readonly providers: Map<string, VirtualDisplayProvider>;

  constructor(
    dataDir: string,
    private readonly options: PreviewDisplayOptions = {},
  ) {
    const providers =
      options.providers ?? (options.provider ? [options.provider] : createDisplayProviders(dataDir, options.log));
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    if (this.providers.size !== providers.length) throw new Error("duplicate display provider id");
  }

  private async selected(requested?: string) {
    const id =
      requested ??
      (await (this.options.getProviderId?.() ?? this.options.provider?.id ?? DEFAULT_VIRTUAL_DISPLAY_PROVIDER));
    return this.providers.get(id);
  }

  private owner(paneId: string) {
    return [...this.providers.values()].find((provider) => provider.getFor(paneId));
  }

  /** Readiness always describes the current selection, not an old display. */
  async readiness(provider?: string): Promise<PreviewDisplayReadiness> {
    return (await this.selected(provider))?.readiness() ?? { supported: false, missing: [] };
  }
  getFor(paneId: string) {
    return this.owner(paneId)?.getFor(paneId) ?? null;
  }
  launchEnv(paneId: string) {
    const owner = this.owner(paneId);
    if (!owner) throw new Error(PREVIEW_DISPLAY_NOT_READY);
    return owner.launchEnv(paneId);
  }
  lostFor(paneId: string) {
    if (this.getFor(paneId)) return null;
    for (const provider of this.providers.values()) {
      const lost = provider.lostFor(paneId);
      if (lost) return lost;
    }
    return null;
  }
  /** Each provider only removes resources in its own namespace. */
  async closeFor(paneId: string) {
    await Promise.all([...this.providers.values()].map(async (provider) => provider.closeFor(paneId)));
  }
  /** Recover all bundled providers, including displays created before a switch. */
  async sweepOrphans(alivePaneIds: string[]) {
    const total = { reaped: 0, rehydrated: 0, locksFreed: 0 };
    for (const provider of this.providers.values()) {
      const result = await provider.sweepOrphans(alivePaneIds);
      total.reaped += result.reaped;
      total.rehydrated += result.rehydrated;
      total.locksFreed += result.locksFreed;
    }
    return total;
  }

  /** Refuse before a provider can allocate anything; cleanup remains available. */
  async openFor(paneId: string, size: VirtualDisplayRequest) {
    if ((await this.options.isEnabled?.()) !== true)
      throw new Error("preview-node-off: turn on Allow virtual displays in this node's settings");
    if (!isNodeSubshellId(paneId)) throw new Error("invalid subshell id");
    if (![size.width, size.height].every((n) => Number.isInteger(n) && n >= 320 && n <= 4096))
      throw new Error(`${PREVIEW_DISPLAY_NOT_READY}: invalid display dimensions`);
    // A new selection affects new displays. Existing panes keep their owner.
    const existing = this.owner(paneId);
    if (existing && size.provider && existing.id !== size.provider)
      throw new Error("preview-display-provider-conflict");
    const provider = existing ?? (await this.selected(size.provider));
    const allowed = await this.options.getEnabledProviderIds?.();
    if (provider && allowed && !allowed.includes(provider.id)) throw new Error("preview-display-provider-disabled");
    const readiness = await provider?.readiness();
    if (!provider || !readiness?.supported) throw new Error(PREVIEW_DISPLAY_UNSUPPORTED);
    if (readiness.missing.length)
      throw new Error(`${PREVIEW_DISPLAY_MISSING_REQUIREMENTS}: ${readiness.missing.join(", ")}`);
    return provider.openFor(paneId, size);
  }
}

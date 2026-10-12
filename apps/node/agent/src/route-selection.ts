import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isPrivateNodeRoute,
  NODE_ROUTE_LIMIT,
  NODE_ROUTE_MAX_BYTES,
  routeDiscoveryUrl,
  sealRouteRequest,
} from "@internal/subshell-protocol/node-route";
import type { NodeConfig } from "./config.js";

export interface NodeRoute {
  url: string;
  authorization: string;
  automatic: boolean;
}
interface ProbedRoute extends NodeRoute {
  elapsedMs: number;
  candidates: string[];
}
export interface RouteSelectionDeps {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Tests isolate cache state and deadlines. */
  cachePath?: string;
  timeoutMs?: number;
}

/** Bound the streamed body too; Content-Length alone isn't a response-size limit. */
async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Empty discovery reply");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > NODE_ROUTE_MAX_BYTES) throw new Error("Discovery reply is too large");
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function candidateList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && isPrivateNodeRoute(v)))].slice(
        0,
        NODE_ROUTE_LIMIT,
      )
    : [];
}

/** Select only at connection boundaries: moving a healthy link interrupts terminal streams. */
export class NodeRouteSelector {
  private readonly failedUntil = new Map<string, number>();
  private preferred: string | undefined;
  private candidates: string[] = [];
  private loaded = false;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly cachePath: string;

  constructor(
    private readonly config: NodeConfig,
    private readonly fallback: string,
    private readonly deps: RouteSelectionDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.cachePath = deps.cachePath ?? join(config.dataDir, "node-routes.json");
  }

  private scope(): string {
    return JSON.stringify([this.config.nodeId, this.config.controlEncryptPublicKey, this.fallback]);
  }

  private async readCache(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await readFile(this.cachePath, "utf8");
      if (text.length > NODE_ROUTE_MAX_BYTES) return;
      const cache = JSON.parse(text);
      if (cache.scope === this.scope()) this.candidates = candidateList(cache.candidates);
    } catch {
      /* A missing or stale hint never prevents a connection. */
    }
  }

  private async remember(candidates: string[]): Promise<void> {
    this.candidates = candidateList(candidates);
    const temporary = `${this.cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(temporary, JSON.stringify({ scope: this.scope(), candidates: this.candidates }), { mode: 0o600 });
      await rename(temporary, this.cachePath);
    } catch {
      /* Hints are optional; every address is authenticated again before use. */
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async probe(url: string, signal?: AbortSignal): Promise<ProbedRoute | null> {
    if (!this.config.controlEncryptPublicKey || !this.config.encryptKeyPair) return null;
    try {
      const request = await sealRouteRequest(this.config.controlEncryptPublicKey, {
        purpose: "node-route-v1",
        nodeId: this.config.nodeId,
        nodeKey: this.config.nodeKey,
        nodePublicKey: this.config.encryptKeyPair.publicKey,
      });
      const start = this.now();
      const response = await this.fetch(routeDiscoveryUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.envelope),
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(this.deps.timeoutMs ?? 1500), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const payload = request.openReply(await boundedText(response));
      if (typeof payload !== "object" || payload === null) return null;
      const reply = payload as Record<string, unknown>;
      if (
        reply.purpose !== "node-route-v1" ||
        typeof reply.ticket !== "string" ||
        !/^[a-f0-9-]{72}$/.test(reply.ticket)
      )
        return null;
      return {
        url,
        // Preserve the configured proxy's existing authentication contract.
        authorization: url === this.fallback ? `Bearer ${this.config.nodeKey}` : `NodeRoute ${reply.ticket}`,
        automatic: url !== this.fallback,
        elapsedMs: this.now() - start,
        candidates: candidateList(reply.candidates),
      };
    } catch {
      return null;
    }
  }

  /** A failed alternate cools down so a reachable HTTP probe cannot trap the daemon on a broken WebSocket route. */
  failed(route: NodeRoute): void {
    if (route.automatic) {
      this.failedUntil.set(route.url, this.now() + 60_000);
      if (this.preferred === route.url) this.preferred = undefined;
    }
  }

  async select(signal?: AbortSignal): Promise<NodeRoute> {
    const fallback = { url: this.fallback, authorization: `Bearer ${this.config.nodeKey}`, automatic: false };
    if (!this.config.controlEncryptPublicKey || !this.config.encryptKeyPair) return fallback;
    await this.readCache();
    for (const [url, until] of this.failedUntil) if (until <= this.now()) this.failedUntil.delete(url);
    const eligible = (url: string): boolean => (this.failedUntil.get(url) ?? 0) <= this.now();
    const initial = [this.fallback, ...this.candidates.filter((url) => url !== this.fallback && eligible(url))];
    const first = await Promise.all(initial.map((url) => this.probe(url, signal)));
    const successes = first.filter((route): route is ProbedRoute => route !== null);
    const advertised = candidateList(successes.flatMap((route) => route.candidates));
    if (signal?.aborted) return fallback;
    const fresh = advertised.filter((url) => !initial.includes(url) && eligible(url));
    const second = await Promise.all(fresh.map((url) => this.probe(url, signal)));
    successes.push(...second.filter((route): route is ProbedRoute => route !== null));
    if (signal?.aborted || successes.length === 0) return fallback;
    await this.remember(advertised);
    successes.sort((a, b) => a.elapsedMs - b.elapsedMs);
    const fastest = successes[0];
    if (!fastest) return fallback;
    const current =
      successes.find((route) => route.url === this.preferred) ?? successes.find((route) => !route.automatic);
    // Keep the existing choice unless the gain is both material and proportional.
    const selected =
      current && current.elapsedMs - fastest.elapsedMs < Math.max(20, current.elapsedMs * 0.2) ? current : fastest;
    this.preferred = selected.url;
    this.deps.log?.(
      `node connection: ${selected.automatic ? "direct" : "configured"} route ${selected.url} (${Math.round(selected.elapsedMs)} ms probe)`,
    );
    return selected;
  }
}

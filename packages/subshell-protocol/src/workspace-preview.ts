import { type PreviewConfiguration, parsePreviewConfiguration } from "./preview-configuration.js";
/** A workspace preview names one resource, independent of its sibling viewers. */
export type WorkspacePreviewTarget =
  | { kind: "app"; port: number; configuration?: PreviewConfiguration }
  | { kind: "service"; serviceId: string; port: number; revision?: number; configuration?: PreviewConfiguration }
  | { kind: "screen" }
  | { kind: "browser" };

export function workspacePreviewId(paneId: string, view: WorkspacePreviewTarget): string {
  const suffix =
    (view.kind === "app" || view.kind === "service") && view.configuration
      ? `:config:${encodeURIComponent(JSON.stringify(view.configuration))}`
      : "";
  return `preview:${paneId}:${view.kind}${view.kind === "app" ? `:${view.port}` : view.kind === "service" ? `:${view.serviceId}:${view.port}${view.revision !== undefined ? `:revision:${view.revision}` : ""}` : ""}${suffix}`;
}

/** Parse the identity rather than trusting saved panel parameters to name its owner. */
export function parseWorkspacePreviewId(id: string): { paneId: string; view: WorkspacePreviewTarget } | null {
  const configAt = id.indexOf(":config:");
  if (configAt !== -1) {
    if (id.length > 4096) return null;
    const base = parseWorkspacePreviewId(id.slice(0, configAt));
    if (!base || (base.view.kind !== "app" && base.view.kind !== "service")) return null;
    try {
      const configuration = parsePreviewConfiguration(JSON.parse(decodeURIComponent(id.slice(configAt + 8))));
      return configuration ? { ...base, view: { ...base.view, configuration } } : null;
    } catch {
      return null;
    }
  }
  const service =
    /^preview:([^:]+):service:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([1-9]\d{0,4})(?::revision:(0|[1-9]\d{0,15}))?$/.exec(
      id,
    );
  if (service)
    return Number(service[3]) <= 65535 && (service[4] === undefined || Number.isSafeInteger(Number(service[4])))
      ? {
          paneId: service[1],
          view: {
            kind: "service",
            serviceId: service[2],
            port: Number(service[3]),
            ...(service[4] !== undefined ? { revision: Number(service[4]) } : {}),
          },
        }
      : null;
  const match = /^preview:([^:]+):(screen|browser|app)(?::([1-9]\d{0,4}))?$/.exec(id);
  if (!match) return null;
  const [, paneId, kind, rawPort] = match;
  if (kind === "app") {
    const port = Number(rawPort);
    return port >= 1 && port <= 65535 ? { paneId, view: { kind, port } } : null;
  }
  return rawPort === undefined ? { paneId, view: { kind: kind as "screen" | "browser" } } : null;
}

export function workspacePreviewLabel(view: WorkspacePreviewTarget): string {
  return view.kind === "app" || view.kind === "service"
    ? `App · ${view.port}`
    : view.kind === "screen"
      ? "Virtual display"
      : "Browser";
}

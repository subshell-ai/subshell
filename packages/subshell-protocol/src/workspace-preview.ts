/** A workspace preview names one resource, independent of its sibling viewers. */
export type WorkspacePreviewTarget =
  | { kind: "app"; port: number }
  | { kind: "service"; serviceId: string; port: number }
  | { kind: "screen" }
  | { kind: "browser" };

export function workspacePreviewId(paneId: string, view: WorkspacePreviewTarget): string {
  return `preview:${paneId}:${view.kind}${view.kind === "app" ? `:${view.port}` : view.kind === "service" ? `:${view.serviceId}:${view.port}` : ""}`;
}

/** Parse the identity rather than trusting saved panel parameters to name its owner. */
export function parseWorkspacePreviewId(id: string): { paneId: string; view: WorkspacePreviewTarget } | null {
  const service =
    /^preview:([^:]+):service:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([1-9]\d{0,4})$/.exec(id);
  if (service)
    return Number(service[3]) <= 65535
      ? { paneId: service[1], view: { kind: "service", serviceId: service[2], port: Number(service[3]) } }
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

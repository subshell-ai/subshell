/** Bundled display choices. Add implementations to pane-runtime's registry too. */
export const VIRTUAL_DISPLAY_PROVIDERS = [
  { id: "xvfb-x11vnc", name: "Xvfb + VNC", description: "Private Linux displays using Xvfb and x11vnc." },
] as const;
export const DEFAULT_VIRTUAL_DISPLAY_PROVIDER = "xvfb-x11vnc";

/** Identifiers are bounded on the wire so older nodes can refuse unknown providers. */
export function isDisplayProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

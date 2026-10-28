/** One user's preferences for a destination, independent of live capabilities. */
export interface PreviewProxySettingsTable {
  /** Authenticated preference owner. */
  userId: string;
  /** Node that dials this destination. */
  nodeId: string;
  /** Normalized service host. */
  host: string;
  /** HTTP transport chosen for the service. */
  protocol: "http" | "https";
  /** Destination port. */
  port: number;
  /** SQLite boolean: rewrite app resource URLs. */
  rewriteUrls: number;
  /** SQLite boolean: forward the preview host. */
  passHost: number;
  /** SQLite boolean: rewrite app redirects. */
  rewriteRedirects: number;
}

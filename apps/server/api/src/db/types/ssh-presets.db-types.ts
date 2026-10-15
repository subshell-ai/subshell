export interface SshPresetTable {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  nodeId: string | null;
  destination: string;
  alias: string | null;
  /** Original resolution token; the saved destination constrains its current resolution. */
  resolutionAlias: string | null;
  authentication: "connecting" | "remote" | "local-key" | "password";
  keyHome: string | null;
  fingerprints: string | null;
  createdAt: string;
  updatedAt: string;
}

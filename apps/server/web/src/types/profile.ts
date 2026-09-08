/**
 * A harness profile as returned by the profiles API.
 * This is the client-facing subset of `ProfileSchema` in the backend
 * (apps/server/api/src/api/models.ts): it carries the fields the frontend uses
 * and omits `userId`, `createdAt`, and `updatedAt`.
 */
export interface ProfileRow {
  id: string;
  harnessId: string;
  name: string;
  description: string | null;
  envJson: string | null;
  flagsJson: string | null;
  settingsJson: string | null;
  configIsolation: number;
  restartOnExit: number;
  /** 1 = auto-seeded default profile: editable, but the API refuses to delete it */
  isDefault: number;
  /**
   * Pinned launch node id (validated visible at pin time); null = any node.
   * The backend always sends it; optional so older cached payloads keep
   * typechecking.
   */
  nodeId?: string | null;
}

/**
 * Database table schema for per-agent-node harness enable/disable.
 * Absent row ⇒ the plugin's enabledByDefault (same lazy rule as harness_plugins).
 */
export interface NodeHarnessTable {
  /** Node this row configures */
  nodeId: string;
  /** Harness plugin id */
  harnessId: string;
  /** 1 enabled / 0 disabled */
  enabled: number;
}

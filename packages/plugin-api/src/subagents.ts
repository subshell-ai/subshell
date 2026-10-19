/** A harness agent belongs to an existing terminal, never to a new subshell. */
export interface HarnessSubagent {
  id: string;
  parentId?: string;
  name: string;
  status: "running" | "waiting" | "idle";
}

/** Navigation is deliberately separate from discovery and from terminal input. */
export interface HarnessSubagentSnapshot {
  agents: HarnessSubagent[];
  selectedId: string | null;
  canSelect: boolean;
  unavailableReason?: string;
}

/** Implementations must select in the existing TUI and preserve unsent input. */
export interface HarnessSubagentSupport {
  discovery: "hooks" | "extension";
  navigation: "native" | "unavailable";
  setup?: string;
}

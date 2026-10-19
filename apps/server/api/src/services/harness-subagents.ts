import type { HarnessSubagent, HarnessSubagentSnapshot } from "@subshell-ai/plugin-api";

interface State extends HarnessSubagentSnapshot {
  generation: string;
  nextLabel: number;
  labels: Map<string, number>;
  lastSeen: number;
  command?: { id: string; agentId: string | null; expiresAt: number };
}

const empty = (): HarnessSubagentSnapshot => ({ agents: [], selectedId: null, canSelect: false });

/** Live presentation state only. The harness remains the authority on its agents. */
export class HarnessSubagents {
  private states = new Map<string, State>();

  read(id: string, generation: string, alive: boolean): HarnessSubagentSnapshot {
    const state = this.states.get(id);
    if (!alive || state?.generation !== generation) {
      this.states.delete(id);
      return empty();
    }
    if (!state) return empty();
    const connected = Date.now() - state.lastSeen < 15_000;
    return {
      agents: state.agents.map((agent) =>
        /^(default|subagent)?$/i.test(agent.name.trim())
          ? { ...agent, name: `Subagent ${state.labels.get(agent.id)}` }
          : agent,
      ),
      selectedId: state.selectedId,
      canSelect: state.canSelect && connected,
      unavailableReason:
        state.canSelect && !connected
          ? "The harness integration isn't responding. Use its own agent selector."
          : (state.unavailableReason ?? "This harness doesn't support switching subagent views from the sidebar."),
    };
  }

  report(
    id: string,
    generation: string,
    input: {
      event: "snapshot" | "start" | "stop" | "reset";
      agents?: HarnessSubagent[];
      agentId?: string;
      selectedId?: string | null;
      canSelect?: boolean;
      unavailableReason?: string;
      acknowledged?: string;
    },
  ): { command?: { id: string; agentId: string | null } } {
    // Bound memory even when a client never revisits deleted subshells.
    if (this.states.size >= 4096 && !this.states.has(id)) this.states.delete(this.states.keys().next().value ?? "");
    let state = this.states.get(id);
    if (!state || state.generation !== generation || input.event === "reset") {
      state = { ...empty(), generation, lastSeen: Date.now(), nextLabel: 1, labels: new Map() };
      this.states.set(id, state);
    }
    state.lastSeen = Date.now();
    if (input.event === "snapshot")
      state.agents = [...new Map((input.agents ?? []).map((agent) => [agent.id, agent])).values()].slice(0, 256);
    if (input.event === "start") {
      for (const agent of input.agents ?? []) {
        state.agents = [...state.agents.filter((a) => a.id !== agent.id), agent].slice(-256);
      }
    }
    if (input.event === "stop") state.agents = state.agents.filter((a) => a.id !== input.agentId);
    const activeIds = new Set(state.agents.map((agent) => agent.id));
    for (const agentId of state.labels.keys()) {
      if (!activeIds.has(agentId)) state.labels.delete(agentId);
    }
    for (const agent of state.agents) {
      if (/^(default|subagent)?$/i.test(agent.name.trim()) && !state.labels.has(agent.id)) {
        state.labels.set(agent.id, state.nextLabel++);
      }
    }
    if (input.selectedId !== undefined) state.selectedId = input.selectedId;
    if (input.canSelect !== undefined) state.canSelect = input.canSelect;
    if (input.unavailableReason !== undefined) state.unavailableReason = input.unavailableReason;
    if (state.command && (state.command.id === input.acknowledged || state.command.expiresAt < Date.now())) {
      delete state.command;
    }
    return state.command ? { command: { id: state.command.id, agentId: state.command.agentId } } : {};
  }

  select(id: string, generation: string, agentId: string | null): boolean {
    const state = this.states.get(id);
    if (!state || state.generation !== generation || !state.canSelect || Date.now() - state.lastSeen >= 15_000)
      return false;
    if (agentId !== null && !state.agents.some((agent) => agent.id === agentId)) return false;
    state.command = { id: crypto.randomUUID(), agentId, expiresAt: Date.now() + 5000 };
    return true;
  }
}

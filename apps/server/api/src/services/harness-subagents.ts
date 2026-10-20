import type { HarnessSubagent, HarnessSubagentSnapshot } from "@internal/pane-runtime";

/**
 * One parent pane's reported subagents, plus the bookkeeping the harness never
 * sees. Lives only in this process: a control-plane restart (or a pane
 * restart) starts from nothing, and the harness re-reports: the harness
 * remains the authority on its children.
 */
interface State extends HarnessSubagentSnapshot {
  /** The parent row's `startedAt`; any change invalidates everything (a restart is a new harness) */
  generation: string;
  /** Counter behind "Subagent N" labels for generic names */
  nextLabel: number;
  /** Agent id to stable number, so a generic name does not renumber between renders */
  labels: Map<string, number>;
  /** Last report received; a stale silence flips `canSelect` off (the harness stopped answering) */
  lastSeen: number;
  /**
   * Task labels that arrived from `PreToolUse` before the child they describe
   * announced itself. Queued per agent type (lowercased; the empty key for
   * unlabeled spawns), FIFO to eight per key. A label whose child never
   * starts is dropped with the next generation, exactly like the roster.
   */
  describeQueue: Map<string, { activity?: string; name?: string }[]>;
  /** Bounded metadata survives child stops so resuming the same child retains its label. */
  descriptions: Map<string, { activity?: string; name?: string }>;
  /** The one pending view-switch command, consumed when the harness acknowledges it or the 5 s lapses */
  command?: { id: string; agentId: string | null; expiresAt: number };
}

const empty = (): HarnessSubagentSnapshot => ({ agents: [], selectedId: null, canSelect: false });

/**
 * The words that mean "no name was given": the queue-key and rename decisions
 * treat these as absence, so a parked label or stored description can replace
 * them. One list for both decisions, because a word generic enough to share
 * the unlabeled queue is generic enough to be renamed from it.
 */
function isGenericAgentName(word: string | undefined): boolean {
  return /^(default|subagent|general-purpose)?$/i.test((word ?? "").trim());
}

/**
 * The narrower set that stands in for the numbered fallback rendering:
 * "general-purpose" sits OUTSIDE it on purpose, because that word is a type
 * name the harness chose and reports back verbatim; it is renamed when a
 * label pairs with it, but a bare report of it is still a name worth showing.
 */
function isNumberedAgentName(word: string): boolean {
  return /^(default|subagent)?$/i.test(word.trim());
}

/** The queue a name or type routes to: lowercased, and generic words share the empty key. */
function typeKey(word: string | undefined): string {
  return isGenericAgentName(word) ? "" : (word ?? "").trim().toLowerCase();
}

/** Takes the oldest parked label for this child's type, if one is waiting. */
function popActivity(state: State, name: string): { activity?: string; name?: string } | undefined {
  const key = typeKey(name);
  const queue = state.describeQueue.get(key);
  const next = queue?.shift();
  if (queue && queue.length === 0) state.describeQueue.delete(key);
  return next;
}

/**
 * The in-memory view of every live pane's reported subagents, keyed by parent
 * id. Nothing here outlives the process or the parent's current run: the
 * numbers, labels, and pending command exist only to render what the harness
 * last told us, and a parent whose row is no longer running (or whose
 * `startedAt` changed) loses its state on the very next read.
 */
export class HarnessSubagents {
  private states = new Map<string, State>();

  /**
   * The snapshot one parent's viewers receive. Generic names ("", "default",
   * "Subagent") come back as "Subagent N" with the N this parent's labels
   * assigned, and `canSelect` answers false with a reason once the harness has
   * been silent for 15 s. Its hooks stopped answering, so navigation would
   * queue into nothing.
   */
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
        isNumberedAgentName(agent.name) ? { ...agent, name: `Subagent ${state.labels.get(agent.id)}` } : agent,
      ),
      selectedId: state.selectedId,
      canSelect: state.canSelect && connected,
      // A reason belongs only with a "no". A working pane (canSelect true and
      // answering) must not carry one, let alone the default "doesn't
      // support" string — the field description promises a reason exactly
      // when selection is off.
      unavailableReason:
        state.canSelect && connected
          ? undefined
          : state.canSelect
            ? "The harness integration isn't responding. Use its own agent selector."
            : state.unavailableReason?.trim() ||
              "Subshell can't switch views in this harness yet. Use the harness's own agent selector.",
    };
  }

  /**
   * Applies one lifecycle report from the parent's own hooks: `snapshot`
   * replaces the roster, `start`/`stop` adjust it, `describe` parks a task
   * label until the child it describes announces itself, and `reset` throws
   * the state away (the pane cleared or forked its conversation). Carries the parent's one pending
   * view command back so the harness can acknowledge it, and renumbers
   * nothing: labels are issued once per agent id and only expire with the
   * agent.
   */
  report(
    id: string,
    generation: string,
    input: {
      event: "snapshot" | "start" | "stop" | "reset" | "describe";
      agents?: HarnessSubagent[];
      agentId?: string;
      /** Agent type a `describe` label belongs to; the empty key takes unlabeled ones */
      agentType?: string;
      /** One-line task label, normalized by the caller before this runs */
      activity?: string;
      agentName?: string;
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
      state = {
        ...empty(),
        generation,
        lastSeen: Date.now(),
        nextLabel: 1,
        labels: new Map(),
        describeQueue: new Map(),
        descriptions: new Map(),
      };
      this.states.set(id, state);
    }
    state.lastSeen = Date.now();
    if (input.event === "describe") {
      if (input.agentId) {
        state.descriptions.set(input.agentId, {
          ...state.descriptions.get(input.agentId),
          ...(input.activity ? { activity: input.activity } : {}),
          ...(input.agentName ? { name: input.agentName } : {}),
        });
        // PostToolUse identifies the exact child, correcting ambiguous parallel spawns.
        // A completed child must never be resurrected by a late description.
        state.agents = state.agents.map((agent) =>
          agent.id === input.agentId
            ? {
                ...agent,
                ...(input.activity ? { activity: input.activity } : {}),
                ...(input.agentName ? { name: input.agentName } : {}),
              }
            : agent,
        );
      } else if (input.activity || input.agentName) {
        const key = typeKey(input.agentType);
        const queue = state.describeQueue.get(key) ?? [];
        queue.push({
          ...(input.activity ? { activity: input.activity } : {}),
          ...(input.agentName ? { name: input.agentName } : {}),
        });
        // Eight live labels per type is more than a turn can pair; an old
        // unclaimed label is worse than no tooltip.
        if (queue.length > 8) queue.shift();
        state.describeQueue.set(key, queue);
        // The type name is pane-chosen text, so the KEY COUNT needs a bound
        // too: sixty-four types is far beyond any fan-out, and Map keeps
        // insertion order, so the oldest type's labels leave first.
        while (state.describeQueue.size > 64) state.describeQueue.delete(state.describeQueue.keys().next().value ?? "");
      }
    }
    if (input.event === "snapshot") {
      const now = Date.now();
      const previous = new Map(state.agents.map((agent) => [agent.id, agent]));
      state.agents = [...new Map((input.agents ?? []).map((agent) => [agent.id, agent])).values()]
        .slice(0, 256)
        .map((agent) => {
          // A periodic snapshot re-lists the same children; their first
          // sighting and any label they were given stay, so elapsed time does
          // not reset every pass and a label never vanishes on a re-list.
          const was = previous.get(agent.id);
          const label = was ? undefined : popActivity(state, agent.name);
          return {
            ...agent,
            // Same rule as `start`: a re-listed child keeps a name its label
            // gave it (the generic word is what the harness re-lists, not the
            // name it has), and a non-generic name is the harness's truth.
            // Without this the rename the comment above promises vanishes on
            // the very next re-list pass.
            name: label?.name ?? (was && isGenericAgentName(agent.name) ? was.name : agent.name),
            startedAt: was?.startedAt ?? now,
            activity: agent.activity ?? was?.activity ?? label?.activity,
          };
        });
    }
    if (input.event === "start") {
      const now = Date.now();
      for (const agent of input.agents ?? []) {
        const previous = state.agents.find((row) => row.id === agent.id);
        const label = previous ? undefined : (state.descriptions.get(agent.id) ?? popActivity(state, agent.name));
        state.agents = [
          ...state.agents.filter((a) => a.id !== agent.id),
          {
            ...agent,
            name: isGenericAgentName(agent.name) ? (label?.name ?? previous?.name ?? agent.name) : agent.name,
            startedAt: previous?.startedAt ?? now,
            activity: agent.activity ?? previous?.activity ?? label?.activity,
          },
        ].slice(-256);
      }
    }
    // Keep only labels, not output or lifecycle state, between runs of a child.
    for (const agent of state.agents) {
      state.descriptions.set(agent.id, { name: agent.name, activity: agent.activity });
    }
    while (state.descriptions.size > 256) state.descriptions.delete(state.descriptions.keys().next().value ?? "");
    if (input.event === "stop") state.agents = state.agents.filter((a) => a.id !== input.agentId);
    const activeIds = new Set(state.agents.map((agent) => agent.id));
    for (const agentId of state.labels.keys()) {
      if (!activeIds.has(agentId)) state.labels.delete(agentId);
    }
    for (const agent of state.agents) {
      if (isNumberedAgentName(agent.name) && !state.labels.has(agent.id)) {
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

  /**
   * Queues a view switch for the harness to pick up on its next report
   * (null returns to the main agent). Returns false, and the caller then
   * answers 409, unless the harness says it can select, has been heard from
   * within 15 s, and the target is a child it actually reported. Queueing is not a
   * promise: if the harness never acknowledges within 5 s the command
   * expires, and the viewer's next read shows the unchanged view.
   */
  select(id: string, generation: string, agentId: string | null): boolean {
    const state = this.states.get(id);
    if (!state || state.generation !== generation || !state.canSelect || Date.now() - state.lastSeen >= 15_000)
      return false;
    if (agentId !== null && !state.agents.some((agent) => agent.id === agentId)) return false;
    state.command = { id: crypto.randomUUID(), agentId, expiresAt: Date.now() + 5000 };
    return true;
  }
}

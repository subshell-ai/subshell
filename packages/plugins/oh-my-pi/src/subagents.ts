/**
 * omp's session event bus already carries the roster the task tool is running:
 * `task:subagent:lifecycle` announces a child's start and settlement, and
 * `task:subagent:progress` streams its status, generated one-line label, and
 * latest intent. The extension below turns those frames into the snapshot
 * reports the control plane reads, so the sidebar shows the children under the
 * subshell that asked for them.
 *
 * Every frame is already bounded by omp; this module bounds again because the
 * report is rendered in the sidebar of the owner and every viewer, and it is
 * the pane's own porcelain that names them (160 characters, like the server).
 * Progress frames arrive at the coalescing rate omp emits (about 150 ms), so
 * they queue one snapshot per second; lifecycle changes report at once.
 *
 * A child session rebinds every extension factory, so this factory runs once
 * per session. Each binding keeps its own roster, and `session_start` tells a
 * child binding apart from the pane's main agent: only the main agent's roster
 * is the set of children the sidebar should hang under the subshell.
 *
 * The roster repeats every two seconds while it is non-empty: the control
 * plane keeps it in memory, so a restart has nothing until the harness reports
 * again, and an idle child produces no other frames.
 */
export const SUBAGENT_BRIDGE = `
export default function (pi) {
  const LIFECYCLE = 'task:subagent:lifecycle';
  const PROGRESS = 'task:subagent:progress';
  const MAX_AGENTS = 256;
  const MAX_TEXT = 160;
  const REPORT_DELAY_MS = 1000;
  // A live child keeps reporting, so a control-plane restart (which forgets
  // every roster) gets the set back without waiting for the next tool event.
  const HEARTBEAT_MS = 2000;

  const agents = new Map();
  let role = 'main';
  let timer = null;
  let reporting = false;
  let queued = false;
  let heartbeat = null;
  let warned = false;
  // omp has no extension hook for moving the TUI's view to a child. The class
  // that owns the move is exposed to extensions as pi.pi.InteractiveMode, so
  // capture the live instance through a property it reads while rendering and
  // call its public focusAgentSession/unfocusSession. Restoring the getter on
  // first read leaves the host untouched afterwards. Verified against omp
  // 18.18.7; if the class or property disappears, the rows stay status-only
  // instead of failing the report.
  let mode = null;
  let probing = false;
  let switchWarned = false;
  let focusing = false;
  let acknowledged;
  let declined;
  const label = value => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().slice(0, MAX_TEXT);
    return trimmed || undefined;
  };
  const validId = id => (typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null);
  const statusFor = status =>
    status === 'pending' ? 'waiting' : status === 'running' ? 'running' : null;

  const put = (id, status, activity) => {
    const key = validId(id);
    if (!key || role !== 'main') return false;
    if (!agents.has(key) && agents.size >= MAX_AGENTS) return false;
    const previous = agents.get(key);
    // The report schema caps the name field at 160 while the id may run to
    // 256; an over-long name would fail validation for the whole snapshot.
    const next = { id: key, name: key.slice(0, MAX_TEXT), status };
    const words = activity || previous?.activity;
    if (words) next.activity = words;
    agents.set(key, next);
    if (heartbeat === null) heartbeat = setInterval(beat, HEARTBEAT_MS);
    return true;
  };

  const drop = id => {
    if (role !== 'main') return false;
    const key = validId(id);
    return key ? agents.delete(key) : false;
  };

  const captureMode = () => {
    if (probing || mode) return;
    const type = pi.pi && pi.pi.InteractiveMode;
    const proto = typeof type === 'function' ? type.prototype : undefined;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'viewSession');
    if (!descriptor || typeof descriptor.get !== 'function') return;
    probing = true;
    Object.defineProperty(proto, 'viewSession', {
      configurable: true,
      get() {
        mode = this;
        Object.defineProperty(proto, 'viewSession', descriptor);
        return descriptor.get.call(this);
      },
    });
  };

  const canSelect = () =>
    role === 'main' &&
    mode !== null &&
    typeof mode.focusAgentSession === 'function' &&
    typeof mode.unfocusSession === 'function' &&
    !mode.collabGuest;
  const selectedId = () => {
    if (!mode) return null;
    const id = mode.focusedAgentId;
    return typeof id === 'string' && agents.has(id) ? id : null;
  };

  const report = async () => {
    if (reporting) {
      queued = true;
      return;
    }
    const base = process.env.SUBSHELL_BASE_URL;
    const token = process.env.SUBSHELL_API_KEY;
    const id = process.env.SUBSHELL_ID;
    if (!base || !token || !id) {
      if (!warned) {
        warned = true;
        pi.logger?.debug?.('subshell subagent report skipped: the pane identity environment is missing');
      }
      return;
    }
    reporting = true;
    try {
      const selectable = canSelect();
      const payload = {
        event: 'snapshot',
        agents: [...agents.values()].slice(0, MAX_AGENTS),
        selectedId: selectedId(),
        canSelect: selectable,
      };
      if (acknowledged !== undefined) payload.acknowledged = acknowledged;
      if (!selectable) {
        payload.unavailableReason =
          mode && mode.collabGuest
            ? 'Viewing agents is unavailable in a collab session.'
            : 'This Oh My Pi build has no agent view to switch. Use its own agent selector.';
      }
      const response = await fetch(base + '/api/subshells/' + encodeURIComponent(id) + '/subagents/report', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        if (!warned) {
          warned = true;
          pi.logger?.debug?.('subshell subagent report failed', { status: response.status });
        }
        return;
      }
      const data = await response.json().catch(() => null);
      const command = data && data.command;
      // The same command comes back until it is acknowledged, and a refused
      // one is skipped rather than retried every heartbeat until it expires.
      if (!command || !selectable || focusing || command.id === acknowledged || command.id === declined) return;
      // The server can still list a child this binding has already dropped:
      // it can settle between the click and the command arriving here.
      // Decline an id this binding no longer tracks rather than asking the
      // host to focus a finished child.
      if (command.agentId !== null && !agents.has(command.agentId)) {
        declined = command.id;
        return;
      }
      const target = mode;
      focusing = true;
      try {
        if (command.agentId === null) await target.unfocusSession();
        else await target.focusAgentSession(command.agentId);
        acknowledged = command.id;
        declined = undefined;
        // Fold the confirmed view and the acknowledgement into a trailing
        // report; the running one already carried the old state.
        void report();
      } catch (error) {
        declined = command.id;
        if (!switchWarned) {
          switchWarned = true;
          pi.logger?.debug?.('subshell subagent view switch failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        focusing = false;
      }
    } catch {
      // A failed report is not fatal: the next frame reports again, and a pane
      // without the identity variables above has no endpoint to reach.
    } finally {
      reporting = false;
      if (queued) {
        queued = false;
        void report();
      }
    }
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void report();
    }, REPORT_DELAY_MS);
  };

  const beat = () => {
    if (role !== 'main' || agents.size === 0) {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      return;
    }
    void report();
  };

  pi.events.on(LIFECYCLE, frame => {
    if (!frame || typeof frame !== 'object' || typeof frame.status !== 'string') return;
    if (frame.status === 'started') {
      if (put(frame.id, 'running', label(frame.description) || label(frame.agent))) schedule();
    } else if (drop(frame.id)) schedule();
  });

  pi.events.on(PROGRESS, frame => {
    if (!frame || typeof frame !== 'object') return;
    const progress = frame.progress;
    if (!progress || typeof progress !== 'object') return;
    const status = statusFor(progress.status);
    if (status) {
      if (put(progress.id ?? frame.id, status, label(progress.description) || label(progress.lastIntent))) schedule();
    } else if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'aborted') {
      if (drop(progress.id ?? frame.id)) schedule();
    }
  });

  const reset = () => {
    agents.clear();
    acknowledged = undefined;
    declined = undefined;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    return report();
  };

  pi.on('session_start', (_event, ctx) => {
    role = ctx && ctx.agent && ctx.agent.kind === 'sub' ? 'sub' : 'main';
    if (role !== 'main') return;
    captureMode();
    return reset();
  });

  // A switch (resume, fork, new) replaces the conversation the roster belonged
  // to; its children are no longer this session's children.
  pi.on('session_switch', () => {
    if (role !== 'main') return;
    return reset();
  });

  pi.on('session_shutdown', () => {
    if (role !== 'main') return;
    return reset();
  });
}
`;

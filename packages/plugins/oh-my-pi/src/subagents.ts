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
 */
export const SUBAGENT_BRIDGE = `
export default function (pi) {
  const LIFECYCLE = 'task:subagent:lifecycle';
  const PROGRESS = 'task:subagent:progress';
  const MAX_AGENTS = 256;
  const MAX_TEXT = 160;
  const REPORT_DELAY_MS = 1000;

  const agents = new Map();
  let role = 'main';
  let timer = null;
  let reporting = false;
  let queued = false;

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
    const next = { id: key, name: key, status };
    const words = activity || previous?.activity;
    if (words) next.activity = words;
    agents.set(key, next);
    return true;
  };

  const drop = id => {
    const key = validId(id);
    return key ? agents.delete(key) : false;
  };

  const report = async () => {
    if (reporting) {
      queued = true;
      return;
    }
    const base = process.env.SUBSHELL_BASE_URL;
    const token = process.env.SUBSHELL_API_KEY;
    const id = process.env.SUBSHELL_ID;
    if (!base || !token || !id) return;
    reporting = true;
    try {
      await fetch(base + '/api/subshells/' + id + '/subagents/report', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'snapshot',
          agents: [...agents.values()].slice(0, MAX_AGENTS),
          selectedId: null,
          canSelect: false,
        }),
        signal: AbortSignal.timeout(2000),
      });
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

  pi.events.on(LIFECYCLE, frame => {
    if (!frame || typeof frame !== 'object' || typeof frame.status !== 'string') return;
    if (frame.status === 'started') {
      if (put(frame.id, 'running', label(frame.description) || label(frame.agent))) void report();
    } else if (drop(frame.id)) void report();
  });

  pi.events.on(PROGRESS, frame => {
    if (!frame || typeof frame !== 'object') return;
    const progress = frame.progress;
    if (!progress || typeof progress !== 'object') return;
    const status = statusFor(progress.status);
    if (status) {
      if (put(progress.id ?? frame.id, status, label(progress.description) || label(progress.lastIntent))) schedule();
    } else if (drop(progress.id ?? frame.id)) schedule();
  });

  pi.on('session_start', (_event, ctx) => {
    role = ctx && ctx.agent && ctx.agent.kind === 'sub' ? 'sub' : 'main';
    if (role !== 'main') return;
    agents.clear();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return report();
  });

  pi.on('session_shutdown', () => {
    if (role !== 'main') return;
    agents.clear();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return report();
  });
}
`;

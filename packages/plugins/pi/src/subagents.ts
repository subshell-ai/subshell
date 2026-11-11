/** pi's bundled subagent example exposes individual results in tool progress. */
export const SUBAGENT_BRIDGE = `
export default function (pi) {
  const agents = new Map();
  const put = (id, name, status = 'running', activity) => {
    if (typeof id !== 'string' || !id.length || id.length > 256 || typeof name !== 'string') return;
    if (!agents.has(id) && agents.size >= 256) return;
    const entry = { id, name: name.trim().slice(0,160) || 'Subagent', status };
    // The hover-card label is a harness one-liner, bounded like the name;
    // the server normalizes it again before storing.
    if (typeof activity === 'string' && activity.trim()) entry.activity = activity.trim().slice(0,160);
    agents.set(id, entry);
  };
  // Async calls keep their children after the launching tool returns; the
  // subagent extension's own lifecycle events retire them. Foreground calls
  // end with the tool, as before.
  const asyncCalls = new Set();
  const asyncRuns = new Map();
  let busy = false;
  const report = async () => {
    if (busy || !process.env.SUBSHELL_API_KEY || !process.env.SUBSHELL_BASE_URL || !process.env.SUBSHELL_ID) return;
    busy = true;
    try { await fetch(process.env.SUBSHELL_BASE_URL + '/api/subshells/' + process.env.SUBSHELL_ID + '/subagents/report', {
      method: 'POST', headers: { authorization: 'Bearer ' + process.env.SUBSHELL_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'snapshot', agents: [...agents.values()].slice(0,256) }),
      signal: AbortSignal.timeout(2000)
    }); } catch {} finally { busy = false; }
  };
  const timer = setInterval(report, 2000); timer.unref?.();
  pi.on('session_start', async () => { agents.clear(); await report(); });
  pi.on('session_shutdown', async () => { clearInterval(timer); agents.clear(); await report(); });
  pi.on('tool_execution_start', async e => {
    if (e.toolName !== 'subagent') return;
    if (e.args?.async !== false) asyncCalls.add(e.toolCallId);
    const tasks = Array.isArray(e.args?.tasks) ? e.args.tasks : e.args?.agent ? [e.args] : [];
    for (let i = 0; i < Math.min(tasks.length,256); i++) put(e.toolCallId + ':' + i, String(tasks[i]?.agent || 'Subagent'));
    await report();
  });
  pi.on('tool_execution_update', async e => {
    if (e.toolName !== 'subagent') return;
    const results = e.partialResult?.details?.results;
    if (!Array.isArray(results)) return;
    for (let i = 0; i < Math.min(results.length,256); i++) {
      const r = results[i]; if (!r) continue; const id = e.toolCallId + ':' + i;
      // The example initializes exitCode to zero before spawning. Its final
      // assistant stop reason, not that provisional code, marks completion.
      const finished = ['stop','end','error','aborted'].includes(r.stopReason);
      if (finished) agents.delete(id);
      else put(id, String(r.agent || 'Subagent'));
    }
    await report();
  });
  pi.on('tool_execution_end', async e => {
    if (!asyncCalls.has(e.toolCallId)) {
      for (const id of agents.keys()) if (id.startsWith(e.toolCallId + ':')) agents.delete(id);
    }
    asyncCalls.delete(e.toolCallId);
    await report();
  });
  // The installed pi-subagents extension publishes a richer lifecycle than
  // the bundled example: one run id, then completion when the child settles.
  // Replace the tool-call rows it supersedes so a single child has one row.
  pi.events.on('subagent:async-started', value => {
    if (!value || typeof value !== 'object') return;
    const call = typeof value.toolCallId === 'string' ? value.toolCallId : '';
    if (call) {
      asyncCalls.add(call);
      for (const id of agents.keys()) if (id.startsWith(call + ':')) agents.delete(id);
    }
    const runId = typeof value.id === 'string' ? value.id : call;
    if (!runId) return;
    const names = Array.isArray(value.agents) && value.agents.length ? value.agents : [value.agent];
    const ids = [];
    for (let i = 0; i < Math.min(names.length,256); i++) {
      const id = runId + ':' + i;
      put(id, String(names[i] || 'Subagent'));
      ids.push(id);
    }
    asyncRuns.set(runId, ids);
    void report();
  });
  pi.events.on('subagent:async-complete', value => {
    const runId = value && typeof value === 'object' && typeof value.runId === 'string' ? value.runId : '';
    if (!runId) return;
    for (const id of asyncRuns.get(runId) || []) agents.delete(id);
    asyncRuns.delete(runId);
    void report();
  });
  // Extensions with their own execution model can publish this metadata-only
  // event instead of emulating the bundled tool's progress payload.
  pi.events.on('subshell:subagents', value => {
    if (!Array.isArray(value?.agents)) return;
    agents.clear();
    for (const a of value.agents.slice(0,256)) if (a) {
      put(a.id, a.name, ['running','waiting','idle'].includes(a.status) ? a.status : 'running', a.activity);
    }
    void report();
  });
}
`;

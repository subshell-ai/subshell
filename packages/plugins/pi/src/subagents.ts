/** pi's bundled subagent example exposes individual results in tool progress. */
export const SUBAGENT_BRIDGE = `
export default function (pi) {
  const agents = new Map();
  const put = (id, name, status = 'running') => {
    if (typeof id !== 'string' || !id.length || id.length > 256 || typeof name !== 'string') return;
    if (!agents.has(id) && agents.size >= 256) return;
    agents.set(id, { id, name: name.trim().slice(0,160) || 'Subagent', status });
  };
  let busy = false;
  const report = async () => {
    if (busy || !process.env.SUBSHELL_API_KEY || !process.env.SUBSHELL_BASE_URL || !process.env.SUBSHELL_ID) return;
    busy = true;
    try { await fetch(process.env.SUBSHELL_BASE_URL + '/api/subshells/' + process.env.SUBSHELL_ID + '/subagents/report', {
      method: 'POST', headers: { authorization: 'Bearer ' + process.env.SUBSHELL_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'snapshot', agents: [...agents.values()].slice(0,256), selectedId: null, canSelect: false }),
      signal: AbortSignal.timeout(2000)
    }); } catch {} finally { busy = false; }
  };
  const timer = setInterval(report, 2000); timer.unref?.();
  pi.on('session_start', async () => { agents.clear(); await report(); });
  pi.on('session_shutdown', async () => { clearInterval(timer); agents.clear(); await report(); });
  pi.on('tool_execution_start', async e => {
    if (e.toolName !== 'subagent') return;
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
    for (const id of agents.keys()) if (id.startsWith(e.toolCallId + ':')) agents.delete(id);
    await report();
  });
  // Extensions with their own execution model can publish this metadata-only
  // event instead of emulating the bundled tool's progress payload.
  pi.events.on('subshell:subagents', value => {
    if (!Array.isArray(value?.agents)) return;
    agents.clear();
    for (const a of value.agents.slice(0,256)) if (a) {
      put(a.id, a.name, ['running','waiting','idle'].includes(a.status) ? a.status : 'running');
    }
    void report();
  });
}
`;

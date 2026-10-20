/** OpenCode's TUI plugin API owns navigation and reports the actual visible route. */
export const SUBAGENT_BRIDGE = `
export default { id: 'subshell-subagents', tui: async (api) => {
  const base = process.env.SUBSHELL_BASE_URL;
  const token = process.env.SUBSHELL_API_KEY;
  const pane = process.env.SUBSHELL_ID;
  if (!base || !token || !pane) return;
  let busy = false, acknowledged;
  const data = (result) => { if (result.error) throw new Error('Session unavailable'); return result.data; };
  const tick = async () => {
    if (busy || api.lifecycle.signal.aborted) return;
    busy = true;
    try {
      const route = api.route.current;
      const selected = route.name === 'session' ? route.params?.sessionID : null;
      let root = selected, agents = [];
      if (root) {
        const visited = new Set();
        while (root && !visited.has(root)) {
          visited.add(root);
          const session = data(await api.client.session.get({sessionID: root}));
          if (!session.parentID) break;
          root = session.parentID;
        }
        const statuses = data(await api.client.session.status());
        const queue = [root], seen = new Set();
        while (queue.length && seen.size < 256) {
          const parent = queue.shift();
          if (seen.has(parent)) continue;
          seen.add(parent);
          const children = data(await api.client.session.children({sessionID: parent}));
          for (const child of children) {
            // An id the route would refuse (over 256) must drop this one
            // entry, not poison the whole snapshot body past the schema.
            if (typeof child.id !== 'string' || !child.id || child.id.length > 256) continue;
            queue.push(child.id);
            const status = statuses[child.id]?.type;
            if (status !== 'busy' && status !== 'retry') continue;
            agents.push({ id: child.id, parentId: typeof child.parentID === 'string' && child.parentID.length <= 256 ? child.parentID : undefined, name: (child.title || 'Subagent').slice(0,160),
              status: api.state.session.permission(child.id).length || api.state.session.question(child.id).length ? 'waiting' : 'running' });
          }
        }
      }
      const response = await fetch(base + '/api/subshells/' + pane + '/subagents/report', {
        method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
        body: JSON.stringify({event:'snapshot', agents:agents.slice(0,256), selectedId: selected && selected !== root && selected.length <= 256 ? selected : null,
          canSelect: Boolean(root), acknowledged}), signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) return;
      const {command} = await response.json();
      if (command && command.id !== acknowledged && root && (command.agentId === null || agents.some(a => a.id === command.agentId))) {
        api.route.navigate('session', {sessionID: command.agentId ?? root});
        acknowledged = command.id;
      }
    } catch {} finally {busy = false;}
  };
  const timer = setInterval(tick, 1000);
  api.lifecycle.onDispose(() => clearInterval(timer));
  await tick();
}};
`;

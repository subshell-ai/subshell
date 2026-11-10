/**
 * omp brokers tool shells through its own daemon, so servers those tools
 * start live outside the pane's process tree and port discovery cannot see
 * them. This extension watches tool results for loopback URLs and reports
 * the ports to the control plane, where the preview picker lists them.
 *
 * It deliberately reports what the output says, not a scan: a tool result
 * from something that executes (bash or a custom tool) is the harness's own
 * evidence that it started something, so file-reading tools are skipped. The
 * report is port-only (the node dials loopback), bounded, and coalesced. A
 * port the harness has not mentioned for ten minutes stops being refreshed,
 * and the server's TTL retires it. A pane without the identity environment
 * has no endpoint and stays quiet.
 */
export const PREVIEW_BRIDGE = `
export default function (pi) {
  const REPORT_DELAY_MS = 750;
  const HEARTBEAT_MS = 60_000;
  const FRESH_MS = 10 * 60_000;
  const MAX_PORTS = 32;
  const MAX_TITLE = 120;
  const MAX_SCAN = 64 * 1024;
  const SKIP_TOOLS = { read: true, edit: true, write: true, grep: true, glob: true };
  const URL_RE = /(?:https?:\\/\\/)?(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):(\\d{1,5})(?!\\d)/gi;

  const ports = new Map();
  let timer = null;
  let heartbeat = null;
  let reporting = false;
  let queued = false;
  let warned = false;
  let disabled = false;
  const prune = now => {
    for (const [port, entry] of ports) {
      if (now - entry.seenAt > FRESH_MS) ports.delete(port);
    }
    if (ports.size === 0 && heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const remember = (port, title) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const now = Date.now();
    prune(now);
    const previous = ports.get(port);
    if (previous) {
      previous.seenAt = now;
      if (title && !previous.title) previous.title = title;
    } else {
      if (ports.size >= MAX_PORTS) return;
      ports.set(port, { title, seenAt: now });
    }
    if (heartbeat === null) heartbeat = setInterval(beat, HEARTBEAT_MS);
    schedule();
  };

  const scan = text => {
    const bounded = text.slice(0, MAX_SCAN);
    URL_RE.lastIndex = 0;
    let match;
    while ((match = URL_RE.exec(bounded))) {
      const port = Number(match[1]);
      const start = bounded.lastIndexOf('\\n', match.index) + 1;
      const end = bounded.indexOf('\\n', match.index);
      const line = bounded.slice(start, end === -1 ? bounded.length : end).trim();
      remember(port, line ? line.slice(0, MAX_TITLE) : undefined);
    }
  };

  const report = async () => {
    if (disabled || ports.size === 0) return;
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
        pi.logger?.debug?.('subshell preview report skipped: the pane identity environment is missing');
      }
      return;
    }
    prune(Date.now());
    if (ports.size === 0) return;
    reporting = true;
    try {
      const response = await fetch(base + '/api/subshells/' + encodeURIComponent(id) + '/views/report', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          ports: [...ports.entries()].map(([port, entry]) => ({
            port,
            ...(entry.title ? { title: entry.title } : {}),
          })),
        }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 404 || response.status === 401) {
        // The server either predates the route or no longer accepts this
        // pane's key. Retrying every heartbeat cannot fix either, so stop
        // until a restart hands the extension a new process.
        disabled = true;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      }
      if (!response.ok && !warned) {
        warned = true;
        pi.logger?.debug?.('subshell preview report failed', { status: response.status });
      }
    } catch {
      // A failed report is not fatal: the next tool result reports again.
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
    prune(Date.now());
    if (ports.size > 0) void report();
  };

  pi.on('tool_result', event => {
    if (!event || event.isError) return;
    const name = typeof event.toolName === 'string' ? event.toolName : '';
    if (SKIP_TOOLS[name] === true) return;
    const content = Array.isArray(event.content) ? event.content : [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') scan(block.text);
    }
  });
}
`;

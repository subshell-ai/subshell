/**
 * omp brokers tool shells through its own daemon, so servers those tools
 * start live outside the pane's process tree and port discovery cannot see
 * them. This extension watches tool results for loopback URLs and reports
 * the ports to the control plane, where the preview picker lists them.
 *
 * It deliberately reports what the output says, not a scan: a tool result is
 * already the harness's own evidence that it started something. The report is
 * port-only (the node dials loopback), bounded, and coalesced. A pane without
 * the identity environment has no endpoint and stays quiet.
 */
export const PREVIEW_BRIDGE = `
export default function (pi) {
  const REPORT_DELAY_MS = 750;
  const HEARTBEAT_MS = 60_000;
  const MAX_PORTS = 32;
  const MAX_TITLE = 120;
  const MAX_SCAN = 64 * 1024;
  const URL_RE = /(?:https?:\\/\\/)?(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):(\\d{1,5})(?!\\d)/gi;

  const ports = new Map();
  let timer = null;
  let heartbeat = null;
  let reporting = false;
  let queued = false;
  let warned = false;
  const remember = (port, title) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const previous = ports.get(port);
    if (!ports.has(port)) {
      if (ports.size >= MAX_PORTS) return;
      ports.set(port, title);
    } else if (title && !previous) {
      ports.set(port, title);
    } else {
      return;
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
    reporting = true;
    try {
      const response = await fetch(base + '/api/subshells/' + encodeURIComponent(id) + '/views/report', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          ports: [...ports.entries()].slice(0, MAX_PORTS).map(([port, title]) => ({
            port,
            ...(title ? { title } : {}),
          })),
        }),
        signal: AbortSignal.timeout(2000),
      });
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
    if (ports.size > 0) void report();
  };

  pi.on('tool_result', event => {
    if (!event || event.isError) return;
    const content = Array.isArray(event.content) ? event.content : [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') scan(block.text);
    }
  });
}
`;

const FEATURES = [
  [
    "Self-hosted",
    "Designed to run on your LAN or VPN, with built-in support for Tailscale, Headscale, NetBird and Cloudflare Tunnel.",
  ],
  [
    "Access your agents from anywhere",
    "Every session in one list, on your phone, a tablet or any browser. Same session, same scrollback, with a key bar for Esc, Ctrl-C and the arrows.",
  ],
  [
    "Get notified when an agent needs you",
    "Subshell sends push notifications when agents are waiting for your input after finishing tasks.",
  ],
  [
    "Spin up agents on remote machines",
    "Register your machines as nodes to launch agents from. Every node connection is encrypted and authenticated.",
  ],
  [
    "Upload files from any device",
    "Drop a screenshot, a log or any file into a session from your phone or another machine for your agent to use.",
  ],
  ["Free and open source", "Subshell Server is licensed under AGPL-3.0, while all other components are Apache-2.0."],
] as const;

export function Features() {
  return (
    <section aria-label="Features" className="mx-auto mt-3.5 w-full max-w-[1020px]">
      <h2 className="mb-3.5 text-center font-mono text-[13px] font-medium uppercase tracking-[.12em] text-[var(--dimmer)]">
        Features
      </h2>
      <ul className="m-0 grid list-none gap-[22px_40px] p-0 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {FEATURES.map(([title, body]) => (
          <li
            key={title}
            className="relative pl-5 before:absolute before:left-0.5 before:-top-0.5 before:text-[22px] before:font-bold before:text-[var(--orchid)] before:content-['·']"
          >
            <h3 className="m-0 text-[15.5px] font-semibold tracking-[-.01em]">{title}</h3>
            <p className="mt-1 max-w-[46ch] text-[14px] leading-[1.65] text-[var(--dim)]">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

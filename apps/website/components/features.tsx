const FEATURES = [
  [
    "Self-hosted",
    "Designed to run on your LAN or VPN, with built-in support for Tailscale, Headscale, NetBird, and Cloudflare Tunnel.",
  ],
  [
    "Access your agents from anywhere",
    "Reconnect to the same sessions and terminal history from your phone, tablet, or desktop browser. A mobile key bar provides Esc, Ctrl-C, and arrow keys.",
  ],
  [
    "Get notified when an agent needs you",
    "Get push notifications when an agent finishes a task or needs your input or approval.",
  ],
  [
    "Run agents on other machines",
    "Enroll your machines as nodes and launch agents on them from the dashboard. Node connections are encrypted and authenticated.",
  ],
  [
    "Upload files from any device",
    "Upload screenshots, logs, and other files to a session from your phone or another device for your agent to use.",
  ],
  [
    "Free and open source",
    "The server code is licensed under AGPL-3.0-only. All other components are licensed under Apache-2.0.",
  ],
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

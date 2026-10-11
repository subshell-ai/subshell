/** Explains deployment ownership and the project's open-source licenses. */
export function SelfHostedSection() {
  return (
    <section
      aria-labelledby="self-hosted-feature"
      className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[1.5fr_.8fr] lg:gap-14"
    >
      <div className="lg:col-start-2 lg:row-start-1">
        <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Self-hosted</p>
        <h2
          id="self-hosted-feature"
          className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
        >
          Self-hosted and open source.
        </h2>
        <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
          Subshell is free and open source. Run it on your own infrastructure with the desktop app, CLI, Docker, or
          Proxmox.
        </p>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-[var(--orchid)]">
          <a href="https://docs.subshell.sh/install" className="underline underline-offset-4 hover:text-[var(--frost)]">
            Choose an installation →
          </a>
          <a
            href="https://github.com/subshell-ai/subshell"
            className="underline underline-offset-4 hover:text-[var(--frost)]"
          >
            View on GitHub →
          </a>
        </div>
      </div>
      <div className="space-y-8 lg:col-start-1 lg:row-start-1">
        <div>
          <h3 className="text-[20px] font-semibold">Your subshell history</h3>
          <p className="mt-2 max-w-[58ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Your server stores your subshell history.
          </p>
        </div>
        <div>
          <h3 className="text-[20px] font-semibold">Open code, clear licenses</h3>
          <p className="mt-2 max-w-[58ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Server code is licensed under AGPL-3.0-only. Clients, the node daemon, and the rest of the project use
            Apache-2.0. Your agent's provider account and usage costs remain separate.
          </p>
        </div>
      </div>
    </section>
  );
}

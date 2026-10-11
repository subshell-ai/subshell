/** Explains deployment ownership and the project's open-source licenses. */
export function SelfHostedSection() {
  return (
    <section
      aria-labelledby="self-hosted-feature"
      className="grid items-start gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[1.2fr_1fr] lg:gap-14"
    >
      <div>
        <h2
          id="self-hosted-feature"
          className="text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
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
      <dl className="grid gap-5 border-t border-[var(--hairline)] pt-6 text-[14px] leading-[1.8] lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
        <div>
          <dt className="font-semibold">History</dt>
          <dd className="mt-1 text-[var(--dim)]">Your server stores your subshell history.</dd>
        </div>
        <div>
          <dt className="font-semibold">Licenses</dt>
          <dd className="mt-1 text-[var(--dim)]">
            Server code is licensed under AGPL-3.0-only. Clients, the node daemon, and the rest of the project use
            Apache-2.0.
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Agent costs</dt>
          <dd className="mt-1 text-[var(--dim)]">Your agent's provider account and usage costs remain separate.</dd>
        </div>
      </dl>
    </section>
  );
}

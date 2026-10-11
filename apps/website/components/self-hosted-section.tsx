/** Explains deployment ownership and the project's open-source licenses. */
export function SelfHostedSection() {
  return (
    <section aria-labelledby="self-hosted-feature" className="border-t border-[var(--hairline)] pt-12">
      <div>
        <h2
          id="self-hosted-feature"
          className="text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
        >
          Self-hosted and open source.
        </h2>
        <p className="mt-5 max-w-[72ch] text-[15px] leading-[1.8] text-[var(--dim)]">
          Subshell is free and open source. Server code is licensed under AGPL-3.0-only; clients, the node daemon, and
          the rest of the project use Apache-2.0. Run it on your own infrastructure with the desktop app, CLI, Docker,
          or Proxmox.
        </p>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-[var(--orchid)]">
          <a
            href="https://github.com/subshell-ai/subshell"
            className="underline underline-offset-4 hover:text-[var(--frost)]"
          >
            View on GitHub →
          </a>
        </div>
      </div>
    </section>
  );
}

import { GitHubIcon } from "./icons";

export function SiteHeader() {
  return (
    <div className="flex items-center gap-6">
      <a href="#top" aria-label="Subshell home" className="inline-flex">
        {/* The wordmark PNG (orchid slash, dotted accent) lives in public/ —
            copied in the same Step-1 dir as the shots. */}
        <img
          src="/shots/wordmark-transparent-96.png"
          alt="Subshell"
          width={96}
          height={21}
          className="h-[26px] w-auto"
        />
      </a>
      <a
        className="ml-auto inline-flex items-center gap-1.5 text-[14px] text-[var(--dim)] hover:text-[var(--frost)]"
        href="https://github.com/subshell-ai/subshell"
      >
        <GitHubIcon />
        GitHub
      </a>
    </div>
  );
}

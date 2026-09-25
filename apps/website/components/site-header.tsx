import { GitHubIcon } from "./icons";

export function SiteHeader() {
  return (
    <div className="flex items-center gap-[26px]">
      <a href="#top" aria-label="Subshell home" className="inline-flex">
        {/* The wordmark PNG (orchid slash, dotted accent) lives in
            public/shots/ beside the other concept shots. */}
        {/* biome-ignore lint/performance/noImgElement: static export with images.unoptimized; raw img is the approved concept markup */}
        <img
          src="/shots/wordmark-transparent-96.png"
          alt="Subshell"
          width={445}
          height={96}
          className="h-[26px] w-auto"
        />
      </a>
      {/* Docs is a sibling site (docs.subshell.sh), not a page of this one:
          an absolute link is the honest shape, and it is the only route off
          the marketing origin besides GitHub. */}
      <a className="ml-auto text-[14px] text-[var(--dim)] hover:text-[var(--frost)]" href="https://docs.subshell.sh">
        Docs
      </a>
      <a
        className="inline-flex items-center gap-1.5 text-[14px] text-[var(--dim)] hover:text-[var(--frost)]"
        href="https://github.com/subshell-ai/subshell"
      >
        <GitHubIcon />
        GitHub
      </a>
    </div>
  );
}

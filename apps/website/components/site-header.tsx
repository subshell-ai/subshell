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

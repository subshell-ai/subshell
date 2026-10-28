import Image from "next/image";

/** Real display and helper screenshots shared with the setup documentation. */
export function VirtualDisplayShowcase() {
  return (
    <section
      id="virtual-displays"
      aria-labelledby="virtual-displays-heading"
      className="mx-auto mb-12 mt-8 w-full max-w-[1220px] border-t border-[var(--hairline)] pt-10"
    >
      <div className="grid items-center gap-8 lg:grid-cols-[.8fr_1.5fr] lg:gap-14">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Virtual displays</p>
          <h2
            id="virtual-displays-heading"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Open a screen alongside your agent.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Run a browser or graphical app on your node, then view and control its screen from the same workspace. Check
            the result and give your agent feedback without switching machines.
          </p>
          <p className="mt-4 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            On Linux, give a subshell its own virtual display. On macOS, use BetterDisplay with Subshell Display Helper,
            included in both desktop apps.
          </p>
          <a
            href="https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux"
            className="mt-5 inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
          >
            Set up a Linux virtual display →
          </a>
        </div>
        <DisplayScreenshot
          name="virtual-display"
          width={1560}
          height={1520}
          alt="A maximized Virtual display tab showing the Northstar sample website in a browser on the node"
          caption="A browser running on a Linux node, controlled from its virtual-display tab."
        />
      </div>
      <div className="mt-10 grid items-center gap-8 lg:grid-cols-[1.5fr_.8fr] lg:gap-14">
        <div className="lg:col-start-2 lg:row-start-1">
          <h3 className="text-[22px] font-semibold leading-tight tracking-[-.025em]">Set up your Mac once.</h3>
          <p className="mt-4 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Install BetterDisplay, then open Virtual Displays in Subshell Client or Subshell Server. Enable the helper
            and grant Screen Recording and Accessibility permissions on that Mac.
          </p>
          <p className="mt-4 max-w-[44ch] text-[14px] leading-[1.8] text-[var(--dim)]">
            Mac virtual screens share your desktop, keyboard focus, and pointer. Move the app onto the virtual screen
            before opening its viewer.
          </p>
          <a
            href="https://docs.subshell.sh/nodes/manage#macos-display-helper"
            className="mt-5 inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
          >
            Follow the macOS setup guide →
          </a>
        </div>
        <div className="lg:col-start-1 lg:row-start-1">
          <DisplayScreenshot
            name="macos-virtual-display-setup"
            width={2080}
            height={1520}
            alt="The desktop assistant's Virtual Displays page with setup instructions and Open Display Helper settings"
            caption="Both desktop apps guide you through enabling the helper on your Mac."
          />
        </div>
      </div>
    </section>
  );
}

function DisplayScreenshot({
  name,
  width,
  height,
  alt,
  caption,
}: {
  name: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
}) {
  return (
    <figure className="m-0 min-w-0">
      <a
        href={`/shots/${name}.webp`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Enlarge screenshot: ${caption}`}
        className="block overflow-hidden rounded-lg border border-[var(--screenshot-border)] bg-[var(--screenshot-background)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--orchid)]"
      >
        <Image
          src={`/shots/${name}.webp`}
          alt={alt}
          width={width}
          height={height}
          unoptimized
          loading="lazy"
          className="block h-auto w-full"
        />
      </a>
      <figcaption className="mt-3 text-[12px] leading-relaxed text-[var(--dim)]">
        {caption} Select to enlarge.
      </figcaption>
    </figure>
  );
}

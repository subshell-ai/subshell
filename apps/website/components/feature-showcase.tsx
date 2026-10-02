import Image from "next/image";
import { SecuritySection } from "./security-section";
import { SelfHostedSection } from "./self-hosted-section";

const SHOTS = {
  workspace: {
    name: "workspace-layout",
    width: 1423,
    height: 898,
    alt: "Codex and Claude Code reviewing code side by side in a Subshell workspace",
    caption: "Two agents, one workspace. On your phone, panes become tabs.",
  },
  prompts: {
    name: "prompt-stack-members",
    width: 830,
    height: 251,
    alt: "A saved review checklist combining project context, review instructions, and report format in order",
    caption: "Build a prompt stack from instructions you already use.",
  },
  presets: {
    name: "preset-library",
    width: 1756,
    height: 612,
    alt: "Saved launch presets for a Codex repository review and a project terminal",
    caption: "Save launch settings for each agent as a preset.",
  },
  sharing: {
    name: "session-sharing",
    width: 855,
    height: 593,
    alt: "Session sharing dialog with separate View and View + edit permissions",
    caption: "Choose who can watch and who can type into the session.",
  },
  nodes: {
    name: "node-enrollment",
    width: 1024,
    height: 989,
    alt: "Add node instructions for connecting another machine with Subshell Client, a server address, and a setup key",
    caption: "Connect another machine using a setup key from your dashboard.",
  },
} as const;

function Screenshot({ shot }: { shot: (typeof SHOTS)[keyof typeof SHOTS] }) {
  const src = `/shots/${shot.name}.webp`;
  return (
    <figure className="m-0 min-w-0">
      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--term)] shadow-[0_18px_60px_-24px_rgba(0,0,0,.55)]">
        <Image
          src={src}
          alt={shot.alt}
          width={shot.width}
          height={shot.height}
          unoptimized
          loading="lazy"
          className="block h-auto w-full"
        />
      </div>
      <figcaption className="mt-3 text-[12px] leading-relaxed text-[var(--dim)]">{shot.caption}</figcaption>
    </figure>
  );
}

function DocumentationLink({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <a
      href={`https://docs.subshell.sh${path}`}
      className="inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
    >
      {children} →
    </a>
  );
}

/** Shows concrete workflows using screenshots from the isolated product demo. */
export function FeatureShowcase() {
  return (
    <div className="mx-auto mb-14 mt-20 w-full max-w-[1220px] space-y-16 sm:mt-24 sm:space-y-24">
      <section
        aria-labelledby="workspace-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[.8fr_1.5fr] lg:gap-14"
      >
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Workspaces</p>
          <h2
            id="workspace-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Give every agent a seat at the desk.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Keep Codex, Claude Code, and a terminal together in one workspace. Split panes to follow several sessions at
            once, compare their output, and move between tasks without losing your place.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/guides/workspaces">Explore workspaces</DocumentationLink>
          </div>
        </div>
        <Screenshot shot={SHOTS.workspace} />
      </section>

      <section
        aria-labelledby="reuse-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[1.5fr_.8fr] lg:gap-14"
      >
        <div className="lg:col-start-2 lg:row-start-1">
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Prompts &amp; presets</p>
          <h2
            id="reuse-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Set up once. Start faster next time.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Save your project context, review checklist, and preferred response format as reusable prompts. Combine them
            into a stack, then use a preset to remember the agent settings, machine, and working directory for your next
            launch.
          </p>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
            <DocumentationLink path="/prompts">Build reusable prompts</DocumentationLink>
            <DocumentationLink path="/presets">Create a preset</DocumentationLink>
          </div>
        </div>
        <div className="grid min-w-0 gap-7 lg:col-start-1 lg:row-start-1">
          <Screenshot shot={SHOTS.prompts} />
          <Screenshot shot={SHOTS.presets} />
        </div>
      </section>

      <section
        aria-labelledby="sharing-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[.8fr_1.5fr] lg:gap-14"
      >
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Session sharing</p>
          <h2
            id="sharing-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Bring someone into the session.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Let a teammate follow the live terminal and its history, or grant edit access so they can type into the same
            session. Sessions are private by default. You choose who gets access from the accounts on your server.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/guides/sharing">How to share a session</DocumentationLink>
          </div>
        </div>
        <div className="w-full max-w-[620px] justify-self-center">
          <Screenshot shot={SHOTS.sharing} />
        </div>
      </section>

      <section
        aria-labelledby="nodes-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[1.5fr_.8fr] lg:gap-14"
      >
        <div className="lg:col-start-2 lg:row-start-1">
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Run on other machines</p>
          <h2
            id="nodes-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Your machines. One dashboard.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Run an agent on your workstation, a spare Mac, or a headless Linux machine. Connect each as a node (a
            machine that runs agents), then choose the machine and project directory when you launch. Follow the output
            and send input from the same dashboard on your phone or desktop.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/nodes">How to connect a machine</DocumentationLink>
          </div>
        </div>
        <div className="w-full max-w-[512px] justify-self-center lg:col-start-1 lg:row-start-1">
          <Screenshot shot={SHOTS.nodes} />
        </div>
      </section>
      <SecuritySection />
      <SelfHostedSection />
    </div>
  );
}

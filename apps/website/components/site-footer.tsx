export function SiteFooter() {
  return (
    <p className="flex flex-wrap justify-between gap-4 text-[12px] text-[var(--dimmer)]">
      <span>
        © 2026{" "}
        <a className="[border-bottom:1px_solid_var(--hairline)]" href="https://disaresta.com">
          Disaresta
        </a>
      </span>
      <span>AGPL-3.0 server · Apache-2.0 everything else</span>
      <a className="[border-bottom:1px_solid_var(--hairline)]" href="https://docs.subshell.sh/about/security-model">
        Security
      </a>
    </p>
  );
}

import { ProductDemo } from "./product-demo";

export function PhoneCard() {
  return (
    <div>
      <ProductDemo
        name="mobile"
        webm={false}
        width={390}
        height={844}
        label="Sending a prompt to Codex, previewing a notification, and switching to the Claude Code tab in a mobile browser"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">Subshell in your mobile browser</p>
    </div>
  );
}

import { ProductDemo } from "./product-demo";

export function PhoneCard() {
  return (
    <div>
      <ProductDemo
        name="mobile"
        webm={false}
        width={390}
        height={844}
        label="Subshell mobile browser sending a prompt to Codex, showing a notification sample, and switching to Claude Code workspace tabs"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">Subshell in your mobile browser</p>
    </div>
  );
}

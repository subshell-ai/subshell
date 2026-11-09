import { t } from "elysia";
export const DisplayProviderIdSchema = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9-]{0,63}$",
  description: "Virtual display provider identifier",
});
export const VirtualDisplayRequestSchema = t.Object(
  {
    width: t.Integer({ minimum: 320, maximum: 4096, description: "Display width in pixels" }),
    height: t.Integer({ minimum: 320, maximum: 4096, description: "Display height in pixels" }),
    provider: t.Optional(DisplayProviderIdSchema),
  },
  {
    description:
      "Virtual display request; an omitted provider takes the node's default, resolved and pinned whenever the display turns on, at launch or at runtime",
  },
);

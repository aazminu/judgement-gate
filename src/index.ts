import { handleWebhook } from "./handler";
import type { Env } from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/webhook") {
      return handleWebhook(req, env, { fetchFn: (input, init) => fetch(input, init),waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("judgement-gate", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

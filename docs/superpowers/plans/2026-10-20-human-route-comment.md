# Human-route comment: plan

> Spec: `docs/superpowers/specs/2026-10-20-human-route-comment-design.md`.

1. **Judgement text** (`src/judgements/one-way-door.ts`). Tests first in `test/judgements.test.ts`: `type1_adr` remedy `why` is not the `ambiguous` text; `probes` returns the Type 1 list (and is override-able like the others).
2. **Renderer** (`src/comment.ts`). Tests first in `test/comment-routing.test.ts`. Add `renderRoutingComment(routing, rc, mode, routingMode, all)` reusing `routingLine`, severity labels and `agentBlock([], ...)`.
3. **Handler** (`src/handler.ts`). Tests first in `test/routing-handler.test.ts`. When `failing` is empty and `routing?.route === "human"`, upsert the routing comment inside the same best-effort `try`.
4. **e2e** (`scripts/e2e.mjs`). Cases 2 and 6: one comment, the routing line, the cleared judgement's `why`, parsed block with `failing: []` and `routing.route === "human"`. `npm run e2e` several times.
5. **Docs**. README, `docs/configuration.md` (the "no comment" sentence), `docs/agents.md`.
6. **Verify and PR.** `npm test`, `npm run typecheck`, e2e x3, open PR with Reversal Trigger / Rollback Path / Owner, wait for CI.

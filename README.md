# judgement-gate

Org-wide pull request gate on a Cloudflare Worker (free tier). A GitHub App sends `pull_request` webhooks; the Worker asks TypeSafe's Jev model (via OpenRouter) whether the change is a one-way door and posts a `judgement-gate` check run. No files needed in any repo.

Type 1 (one-way) changes need an ADR in `docs/decisions/*.md`. Type 2 (reversible) changes need a Reversal Trigger and Rollback Path in the PR body. Failures get one remediation comment, edited in place on later pushes.

## Demo in 2 minutes (no GitHub App needed)

Real Worker, real Jev call, fake GitHub.

```bash
npm install
OPENROUTER_API_KEY=sk-or-... node scripts/init-dev-vars.mjs   # writes .dev.vars (gitignored)
npm run mock-github      # terminal 1: fake GitHub API on :8788
npm run dev              # terminal 2: Worker on :8787
npm run simulate -- 1    # terminal 3: send a signed webhook
```

| Scenario | PR | Expected |
|---|---|---|
| 1 | drops a column, no ADR | FAILURE + ADR comment |
| 2 | same, with `docs/decisions/*.md` | SUCCESS |
| 3 | flagged feature, has reversal plan | SUCCESS |
| 4 | flagged feature, no plan | FAILURE + 3-line comment |

Check results and comments print in the mock-github terminal. Edit `scripts/scenarios.mjs` to add your own.

`npm run jev-smoke` calls Jev directly to verify your key. `npm test` runs 19 unit and end-to-end tests with fake GitHub and Jev. `npm run typecheck` runs tsc.

## Deploy for real

1. Create a GitHub App: webhook URL `https://<worker>.workers.dev/webhook`, a webhook secret, permissions **Checks: read & write**, **Pull requests: read**, **Issues: read & write** (comments), subscribe to **Pull request**. Install it on the org or a test repo.
2. Convert the downloaded key to PKCS#8 (Web Crypto cannot import the PKCS#1 key GitHub gives you):
   `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`
3. Set secrets, then deploy:
   ```bash
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
   npx wrangler secret put JEV_API_KEY        # your OpenRouter key
   npx wrangler deploy
   ```

## Rollout modes

`MODE` in `wrangler.toml`:
- `shadow` (default): the check always passes and the title reads `[Shadow] <verdict>`. Use it to calibrate.
- `enforce`: real success/failure. Making it block merges is done on the GitHub side with an organization ruleset that requires `judgement-gate`.

## Behaviour notes

- Webhook is acknowledged with 202 immediately; work runs in `ctx.waitUntil`, so GitHub's 10s timeout never applies.
- Handled actions: `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited` only when title or body changed. Drafts are ignored.
- Jev error, bad response, or timeout (`JEV_TIMEOUT_MS`, default 2500) gives conclusion `neutral` titled `[Audit Degraded]`. It fails open.
- Diff sent to Jev is capped at 50KB, with migrations, SQL, manifests, infra config and models first.
- Jev contract: `POST /api/alpha/decisions` on OpenRouter, model `typesafe/jev-1.14`. This is an alpha API and may change.

## Things to know before the team demo

- **Confidence threshold.** The PRD's 0.75 applies to Jev's `confidence`, which measures how concentrated the distribution is (0.66/0.34 gives 0.32), not top probability. Clear-cut PRs score 0.9+ so the demo works, but borderline ones will often land on "Ambiguous". Tune `CONFIDENCE_THRESHOLD` during shadow mode.
- **Free tier.** The Worker uses well under the 10ms CPU limit, but the free plan allows 100k requests/day. Each PR event costs 1 Worker request plus 4-5 GitHub subrequests, within the 50 subrequest limit.
- **Not built:** persistent metrics for the p95 latency and false-positive KPIs. The Worker is stateless; read them from `wrangler tail` logs or add Workers Analytics Engine later.

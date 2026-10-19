# Operating the gate

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

## Things to know

- **Confidence threshold.** The 0.75 default applies to Jev's `confidence`, which measures how concentrated the distribution is (0.66/0.34 gives 0.32), not top probability. Clear-cut PRs score 0.9+, but borderline ones will often land on "Ambiguous". Tune `CONFIDENCE_THRESHOLD` during shadow mode.
- **Free tier.** The Worker uses well under the 10ms CPU limit, but the free plan allows 100k requests/day. Each PR event costs 1 Worker request plus 4-5 GitHub subrequests, within the 50 subrequest limit.
- **Metrics:** p95 latency, flag rate and false positives are recorded in Workers Analytics Engine when the `ANALYTICS` binding is present. See [calibration.md](calibration.md). Still not built: override tracking beyond the false-positive reply.

# Operating the gate

## Rollout modes

`MODE` in `wrangler.toml`:
- `shadow` (default): the check always passes and the title reads `[Shadow] <verdict>`. Use it to calibrate.
- `enforce`: real success/failure. Making it block merges is done on the GitHub side with an organization ruleset that requires `judgement-gate`.

## Behaviour notes

- Webhook is acknowledged with 202 immediately; work runs in `ctx.waitUntil`, so GitHub's 10s timeout never applies.
- Handled actions: `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited` only when title or body changed. Drafts are ignored.
- Jev error, bad response, or timeout (`JEV_TIMEOUT_MS`, default 2500) gives conclusion `neutral` titled `[Audit Degraded]`. It fails open.
- When all applicable judgements pass, an existing gate comment is updated in place, clearing its remediation text and hidden failing instructions. The passing note never creates a new comment; human-review routing comments keep their existing behaviour. Shadow-mode failures still show remediation, and degraded evaluations leave existing comments unchanged. A comment API failure adds a diagnostic to the check summary without changing the verdict.
- Diff sent to Jev is capped at 50KB, with migrations, SQL, manifests, infra config and models first.
- Jev contract: `POST /api/alpha/decisions` on OpenRouter, model `typesafe/jev-1.14`. This is an alpha API and may change.

## End-to-end run

`npm run e2e` starts a scripted Jev (`scripts/jev-stub.mjs`), the mock GitHub and the real Worker via `wrangler dev`, sends signed webhooks for the demo scenarios in `scripts/scenarios.mjs`, and asserts on what the mock recorded (check conclusion and summary, comment, label, the hidden agent block). The stub's answers come from each scenario's `jev` field; failure modes (Jev down, unrecognised severity) are switched on the stub over HTTP. It needs no secrets, never reads your `.dev.vars`, and writes server logs to `e2e-logs/`. CI runs it as the `e2e` job, which uploads those logs when it fails. To cover a new behaviour, add a scenario (files and `jev` answers) and a case in `scripts/e2e.mjs`.

The comment lifecycle cases reuse one PR across failure, a description edit adding a reversal plan, a repeated pass, and an edit removing the plan. They verify that the same comment ID is kept, stale remediation is cleared on success, and a later failure restores the remediation. Set `reusePr: true` on a case to evaluate the previous PR again without clearing its comment state.

## Things to know

- **Confidence threshold.** The 0.75 default applies to Jev's `confidence`, which measures how concentrated the distribution is (0.66/0.34 gives 0.32), not top probability. Clear-cut PRs score 0.9+, but borderline ones will often land on "Ambiguous". Tune `CONFIDENCE_THRESHOLD` during shadow mode.
- **Free tier.** The Worker uses well under the 10ms CPU limit, but the free plan allows 100k requests/day. Each PR event costs 1 Worker request plus 4-5 GitHub subrequests, within the 50 subrequest limit.
- **Metrics:** p95 latency, flag rate and false positives are recorded in Workers Analytics Engine when the `ANALYTICS` binding is present. See [calibration.md](calibration.md). Still not built: override tracking beyond the false-positive reply.

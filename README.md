# judgement-gate

Org-wide pull request gate on a Cloudflare Worker (free tier). A GitHub App sends `pull_request` webhooks; the Worker asks TypeSafe's Jev model (via OpenRouter) a set of **judgements** about the change and posts one `judgement-gate` check run. No files needed in any repo.

A judgement is a named question, a threshold, a way for the author to clear it, and a remedy that explains why it matters and what to do. Out of the box there is one: `one-way-door`. Type 1 (one-way) changes need an ADR in `docs/decisions/*.md`; Type 2 (reversible) changes need a Reversal Trigger and Rollback Path in the PR body. Add your own in YAML (see [Judgements](#judgements)). Failures get one remediation comment, edited in place on later pushes, with a "why" and a "fix" per judgement.

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
| 5 | breaks a public API, no migration plan (uses `examples/judgement-gate.yml`) | FAILURE + API-contract comment |
| 6 | same, with `Migration Plan:` in the body | SUCCESS |

The mock serves `examples/judgement-gate.yml` as the org config; set `MOCK_CONFIG=path` to try your own. Scenarios 1-4 also show `applies_to` at work: the API judgement is skipped because no changed file is under `services/api/`.

Check results and comments print in the mock-github terminal. Edit `scripts/scenarios.mjs` to add your own.

`npm run jev-smoke` calls Jev directly to verify your key. `npm test` runs the unit and end-to-end tests with fake GitHub and Jev. `npm run typecheck` runs tsc.

## Deploy for real

1. Create a GitHub App: webhook URL `https://<worker>.workers.dev/webhook`, a webhook secret, permissions **Checks: read & write**, **Pull requests: read**, **Issues: read & write** (comments), **Contents: read** (to read the org judgement config), subscribe to **Pull request**. Install it on the org or a test repo. If you use org-level judgements, include the org's `.github` repo in the installation. Adding Contents: read to an existing install means the org must accept the permission update.
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

## Judgements

A judgement is what the gate asks about a change. The Worker sends every applicable judgement to Jev in one request, then posts one check and one comment.

**No config needed.** Without a config file, the built-in `one-way-door` judgement runs and reaches the same verdicts as before. The comment wording is now a "Why" and a "Fix", and the check summary lists each judgement.

**Add your own.** Create `.github/judgement-gate.yml` in your organisation's `.github` repo (repo name overridable with `CONFIG_REPO`). Protect it with CODEOWNERS and branch protection that requires Code Owner review on that repo's default branch: whoever approves changes to that file owns the org's judgement. It is always read from the **default branch**, so a PR cannot change the rules that gate it. See [examples/judgement-gate.yml](examples/judgement-gate.yml).

| Key | Meaning |
|---|---|
| `use` | Enable a built-in (`one-way-door`). Only `confidence_threshold` and `applies_to` may be overridden. |
| `id`, `name` | Unique id (kebab-case) and the name shown in the comment. |
| `question`, `true`, `false` | The yes/no question for Jev, and what each answer means. |
| `threshold` | 0 to 1. Flagged when the probability of "true" is at least this. |
| `applies_to` | Optional globs (`*`, `**`, `?`). Judged only if a changed file matches. Omit for always. |
| `satisfied_by` | Required. Any one entry clears the flag: `pr_body_matches` (regex, `(?i)` prefix for case-insensitive, max 200 chars) or `file_added` (glob on an added or modified file). |
| `why`, `fix` | The remedy shown to the author: why it matters, and what to do. |

**If the config is wrong.** A missing file, an empty file, or `judgements: []` runs the built-in default. A YAML or schema error, or a config that cannot be read (for example a missing Contents permission), also falls back to the built-in, and the check summary says so. A bad config never blocks a PR.

**Config not picked up?** GitHub answers 404 for a repo the app cannot see, which looks the same as "no config file". If your judgements never run, check that the org's `.github` repo is part of the app installation (not just "selected repositories" without it).

**Cost.** One extra GitHub request per event. The Worker also asks the Cloudflare Cache API to hold the config for 60 seconds, but the Cache API does nothing on `*.workers.dev` domains, so budget one request per event unless you deploy on a custom domain.

**Regex caution.** `pr_body_matches` patterns run against PR bodies written by anyone. Keep them simple: a pattern with nested repeats can run for a very long time on a crafted body.

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

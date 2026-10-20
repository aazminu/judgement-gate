# judgement-gate

**Codify your team's judgement and apply it to every pull request.**

Agentic coding writes code faster than people can build the judgement to review it. Judgement (is this reversible? does this break a consumer?) is hard to teach and hard to automate. Linters can't check it, because it depends on business logic and intent. Models like TypeSafe's Jev can answer these questions, so you can write the judgement down once and apply it to every PR, whether a person or an agent wrote it.

The gate also teaches. A failure comment says *why* the change matters and *how* to clear it, so an agent can fix its own PR and a new engineer learns what the team cares about.

It runs as a Cloudflare Worker (free tier). A GitHub App sends `pull_request` webhooks; the Worker asks Jev (via OpenRouter) a set of **judgements** about the change and posts one `judgement-gate` check run. No files needed in any repo.

## Judgements

A judgement is a named question, a threshold, a way for the author to clear it, and a remedy. One is built in, `one-way-door`: Type 1 (one-way) changes need an ADR in `docs/decisions/*.md`; Type 2 (reversible) changes need a Reversal Trigger and Rollback Path in the PR body. Add your own in YAML:

```yaml
judgements:
  - use: one-way-door
  - id: public-api-contract
    name: Public API contract change
    question: "Does this change break or remove a public API contract?"
    true: "removes/renames endpoints, fields or exported symbols"
    false: "additive or internal only"
    threshold: 0.6
    applies_to: ["services/api/**"]
    satisfied_by:
      - pr_body_matches: "(?i)^Migration Plan:"
    why: "Consumers cannot roll back with us. Breaking changes need a migration plan."
    fix: "Add a 'Migration Plan:' line to the PR description."
```

A judgement can also carry `probes`, short questions a reviewer will ask, shown in the comment and the agent block; the built-in `one-way-door` ships defaults you can override.

Full reference: [docs/configuration.md](docs/configuration.md).

AI agents: each comment embeds a hidden JSON block saying how to clear every failing judgement; see [docs/agents.md](docs/agents.md).

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
| 5 | breaks a public API, no migration plan (uses `examples/judgement-gate.yml`) | FAILURE: API-contract judgement fails (one-way door usually reads "Ambiguous" too) |
| 6 | same, with `Migration Plan:` in the body | API-contract judgement passes; one-way door can still read "Ambiguous" and fail the check |

Scenarios 5 and 6 are about the per-judgement lines in the check summary, not the overall result. Borderline PRs like these pass if you lower `CONFIDENCE_THRESHOLD`; tune it in shadow mode. The mock serves `examples/judgement-gate.yml` as the org config; set `MOCK_CONFIG=path` to try your own, and edit `scripts/scenarios.mjs` to add scenarios.

`npm run jev-smoke` calls Jev directly to verify your key. `npm test` runs the unit and end-to-end tests. `npm run typecheck` runs tsc.

## Deploy for real

1. Create a GitHub App: webhook URL `https://<worker>.workers.dev/webhook`, a webhook secret, permissions **Checks: read & write**, **Pull requests: read**, **Issues: read & write** (comments), **Contents: read** (to read the org judgement config), subscribe to **Pull request** and **Issue comment** (the second lets people reply `/judgement-gate false-positive <id>` to a flag; no new permission needed, and without it only the false-positive log is lost). Install it on the org or a test repo, including the org's `.github` repo if you use org-level judgements.
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

## Suggested rollout

1. **Shadow on a few repos (2 weeks).** `MODE = "shadow"` is the default: the check always passes. Pick repos with real migrations, infra changes and agent-authored PRs.
2. **Review the flags with the team.** Would we have caught this? Was the flag wrong? Use the answers to tune thresholds.
3. **Enforce on one willing repo.** Set `MODE = "enforce"` and add an organisation ruleset that requires `judgement-gate`.
4. **Add judgements** each time review catches something the gate missed.

More in [docs/operations.md](docs/operations.md).

## Data and privacy

For each PR event the Worker sends Jev (through OpenRouter) the PR title and body, the changed-file list, and a diff capped at 50KB. The Worker stores nothing. Check that this is acceptable for your repos, and use the app's repository selection to limit where it runs.

## Status

Alpha. The Jev API (`/api/alpha/decisions`) may change, Jev's confidence score is not a probability, and the gate fails open: if Jev is unavailable the check is `neutral` and the PR is not blocked. Evaluations and false-positive replies are logged to Workers Analytics Engine (optional) so shadow-mode thresholds can be tuned from data; see [docs/calibration.md](docs/calibration.md).

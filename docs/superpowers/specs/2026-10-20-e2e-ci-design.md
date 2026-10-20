# End-to-end scenarios in CI: design

## Intent

The vitest suite calls `handleWebhook` and `processPullRequest` in process with a fake `fetch`. It never runs `src/index.ts`, the real `Request` plumbing, `ctx.waitUntil`, the Workers runtime or an HTTP hop to Jev and GitHub. The maintainer validated the merged main by hand with the real Worker, the project's mock GitHub and a scripted stand-in for Jev. `npm run e2e` automates exactly that run, and CI runs it as a separate job so regressions in the real Worker path show up as the business logic keeps changing.

Everything is local and secret-free: no OpenRouter, no real Jev, no network beyond loopback.

## Moving parts

`scripts/e2e.mjs` spawns three servers on free ports, each logging to `e2e-logs/<name>.log`:

1. **Scripted Jev** (`scripts/jev-stub.mjs`). `POST /` takes `{model, state, questions}` and returns `{answers}`. It does not look at the PR text. The harness sets what to answer through `POST /__control {mode, answers}` before each scenario; `GET /__control` reads it back. `mode` is `ok`, `down` (HTTP 503) or `badsev` (every `choice` question that is not `synthetic_classification` gets an unrecognised value; one-way-door still answers normally).
2. **Mock GitHub** (`scripts/mock-github.mjs`, extended). `GET /__recorded` returns the checks, comments and labels it received as JSON; `POST /__reset` clears them; `POST /__register {pr, files}` lets the harness give a PR number its own changed files, so every scenario run can use a fresh PR number. Console output and the demo behaviour are unchanged.
3. **The Worker**, via `node node_modules/wrangler/bin/wrangler.js dev --env-file <tmp>/e2e.env`. The env file holds a throwaway PKCS#8 key generated at runtime, `GITHUB_WEBHOOK_SECRET=dev-secret`, `GITHUB_APP_ID=1`, `JEV_API_KEY=dev-test-key`, `GITHUB_API_URL`/`JEV_API_URL` on loopback, `MODE=enforce`. The user's own `.dev.vars` is never read or written, and local persistence goes to a temp dir.

## Scenario data

`scripts/scenarios.mjs` gets a `jev` field per scenario: a map of Jev question key to answer, built with two small helpers (`noul(p)`, `choice(value, confidence)`). The same file holds the changed files, so the stub's behaviour and the mock's file list are driven by one scenario record. A question key the scenario does not answer is omitted from the stub's response, so a new judgement added to `examples/judgement-gate.yml` makes the run degrade loudly instead of passing by luck.

## Flow and waiting

For each case: register the PR's files with the mock, set the stub mode and answers, post the signed webhook (fresh PR number and head sha), expect `202`, then poll `/__recorded` until the check run for that head sha is completed (the final write the Worker makes, after label and comment), bounded by a timeout. Cases run one after another, so the single stub control state is safe.

Assertions are on conclusions, labels, key lines and fields parsed from the hidden block (`/<!-- judgement-gate:v(\d+) (\{.*\}) -->/`). Never whole-comment equality. A failing case prints expected vs actual per check; the script exits 1 after running every case.

## Cases

The seven demo scenarios as specified by the maintainer (1 Type 1 no ADR; 2 Type 1 with ADR; 3 Type 2 with plan; 4 Type 2 no plan; 5 API break no plan; 6 same with `Migration Plan:`; 7 reversible checkout change), plus failure modes: Jev `down` on 1 (neutral `[Audit Degraded]`, still labelled by the `migrations/**` rule, summary says `judgement rules skipped`), `down` on 4 (neutral, routing `unavailable`, no label), `badsev` on 7 and 5 (`Severity (no level reported)`, rest unchanged).

## Safety

- Ports: `net.listen(0)` for each server; children get `PORT`. Never a fixed port, so a busy 8787/8788 is irrelevant.
- Teardown in a `finally`, on SIGINT/SIGTERM and on the overall timeout (120 s): `taskkill /T /F` on Windows, process-group kill elsewhere (children are spawned detached on POSIX). Wrangler spawns `workerd`, so killing only the direct child is not enough.
- Readiness is polled (`/health`, `/__recorded`, `GET /__control`) with a bounded timeout and fails with the log tail.

## CI

A separate `e2e` job in `ci.yml`: same checkout/setup-node/cache pattern and pinned versions, `timeout-minutes: 10`, `contents: read`, no secrets, `npm ci` then `npm run e2e`. The log directory is `e2e-logs/`, not a dot-directory, because `upload-artifact` skips hidden files by default. On failure the logs are uploaded with `actions/upload-artifact` at a version that dependabot's grouped github-actions updates already track. The existing `ci` job is untouched. Whether the job is required is the maintainer's call.

## Out of scope

No `src/` changes. Any bug found in `src/` is reported, not fixed.

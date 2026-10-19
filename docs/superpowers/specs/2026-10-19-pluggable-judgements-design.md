# Pluggable judgements: design

## Intent

judgement-gate asks one hardcoded question today: "is this a one-way door?". The product pitch is *codified judgement*: agents write code faster than people can build the judgement to review it, and a model like Jev lets a team encode that judgement as a repeatable check. So the unit of the product should be **a judgement**: a named question, a model, a threshold, and a remedy. The remedy is the teaching half: it explains to the author (human or agent) why the change matters and what to do, which is how judgement gets passed on.

Teams must be able to add judgements without the Worker's operator shipping code, and without adding files to every repo. The install story (one GitHub App on a Cloudflare Worker, zero files in repos) stays intact.

## Goals

- A judgement is a first-class, named thing: `id`, `name`, question(s) for Jev, threshold, "how the author answers it" (evidence), and a remedy (`why` + `fix`).
- Judgements are defined in YAML in the org's `.github` repo, owned via CODEOWNERS. No YAML means today's behaviour exactly.
- The existing one-way-door logic becomes the first **built-in** judgement, behaviour unchanged. YAML can enable and retune it.
- All applicable judgements are evaluated in one Jev request (same latency and subrequest budget as today).
- The `judgement-gate` check name, shadow/enforce modes, fail-open behaviour and single edit-in-place comment are preserved.

## Non-goals (v1)

- Per-repo judgement files. Org-level only. (Designed so it can be added later; the loader takes a "source" list.)
- A UI, database, KV, or any new state. The Worker stays stateless.
- Arbitrary code in YAML. Custom decision logic lives in built-ins in the Worker code.
- Per-judgement shadow/enforce mode or per-judgement check runs.
- Gating changes to the judgement YAML itself with a special judgement. CODEOWNERS on the file covers governance for now.

## Anti-goals (would be a failure even if it technically works)

- A PR can change the rules that gate it. Config is read from the **default branch**, never the PR head.
- A broken YAML file blocks merges or silently disables all gating. It must fall back to the built-ins and say so.
- A judgement that can never be satisfied (flags forever with no way to clear it).
- Repos having to add files or teams to redeploy the Worker to add a judgement.

## Constraints

- Cloudflare Worker, free tier: under 10ms CPU, at most 50 subrequests per event. Today a PR event costs 4-5 GitHub subrequests; the config fetch adds 1 (0 on cache hit).
- Jev is an alpha API (`POST /api/alpha/decisions`); the 2.5s timeout and fail-open behaviour stay.
- GitHub App needs a new permission: **Contents: read**. Orgs must accept the permission update. README must say so.
- Existing tests (19) and scripts (mock-github, simulate) must keep working.

## Design

### Judgement model

Internal shape, after loading (names are guidance; builder may adjust):

```ts
interface Judgement {
  id: string;                       // unique, kebab-case
  name: string;
  appliesTo?: string[];             // globs against changed filenames; omitted = always
  questions: Record<string, JevQuestion>;          // local keys; namespaced as `${id}.${key}` in the request
  decide(answers, ctx): JudgementVerdict;          // pass | fail | ambiguous, plus reason
  remedy(verdict, ctx): { why: string; fix: string };
}
```

Two ways to produce one:

1. **Built-in (code):** `one-way-door` keeps its four questions, its ADR check (`docs/decisions/*.md`), its ambiguity rule and its three remediation texts. Moved out of `jev.ts`/`policy.ts`/`comment.ts` into `src/judgements/one-way-door.ts` with no behaviour change.
2. **Declarative (YAML):** compiled into a `Judgement` by a generic decider.

### YAML schema

File: `.github/judgement-gate.yml` in the org's `.github` repo (repo name overridable with a `CONFIG_REPO` var, default `.github`).

```yaml
judgements:
  - use: one-way-door              # built-in; optional overrides
    confidence_threshold: 0.75

  - id: public-api-contract        # declarative
    name: Public API contract change
    question: "Does this change break or remove a public API contract?"
    true: "removes/renames endpoints, fields or exported symbols"
    false: "additive or internal only"
    threshold: 0.6                 # flag when P(true) >= threshold
    applies_to: ["services/api/**"]
    satisfied_by:                  # required; list = any of
      - pr_body_matches: "(?i)^Migration Plan:"
      - file_added: "docs/api-changes/*.md"
    why: "Consumers cannot roll back with us. Breaking changes need a plan."
    fix: "Add a 'Migration Plan:' line to the PR description."
```

Rules:
- `use:` names a built-in; allowed overrides are limited to documented ones (v1: `confidence_threshold`, `applies_to`).
- A declarative judgement requires `id`, `name`, `question`, `true`, `false`, `threshold` (0-1), `satisfied_by` (non-empty), `why`, `fix`. `satisfied_by` is required so no judgement is unsatisfiable (anti-goal). `id`s are unique across the file.
- `applies_to` uses simple globs (`*`, `**`, `?`). A judgement runs if any changed file matches; if none match it is skipped and not sent to Jev.
- `satisfied_by` entry types: `pr_body_matches` (regex on PR body) and `file_added` (glob matching an added/modified, non-removed file). Regex length is capped; patterns are authored by trusted CODEOWNERS.
- Declarative decision: Jev answers the single `noul` question; if P(true) >= `threshold` and no `satisfied_by` entry holds, the verdict is fail; otherwise pass.
- Absent `judgements:` key, empty file, or no file: built-in default list = `[one-way-door]`.

### Config loading

- Fetch via the contents API with the installation token: `GET /repos/{owner}/{CONFIG_REPO}/contents/.github/judgement-gate.yml` (no `ref`, so default branch). 404 means "no config".
- Cache in the Workers Cache API for 60s keyed by owner, so bursts of PR events cost no extra subrequest.
- Parse with the `yaml` package (works in Workers; builder to confirm bundle size and CPU time on a worst-case file). Validate against the schema above.
- **Invalid config** (parse error, schema error, unknown `use:`, duplicate id): use the default built-in list, and append a note to the check summary ("Config error: ...; fell back to built-in judgements"). Do not fail the check because of it.
- Required token permission: Contents: read on the `.github` repo (installation must include that repo).

### Evaluation

1. Load config, resolve judgements, filter by `applies_to` against the PR's changed files.
2. Build **one** Jev request: `state` as today, `questions` = union of each judgement's questions, keys namespaced `${id}.${key}`. If no judgement applies, skip Jev and pass with "No applicable judgements".
3. Each judgement's `decide` gets its own answers (namespace stripped) and returns a verdict.
4. Aggregate:
   - Any fail: check `failure` (or `success` with `[Shadow]` title in shadow mode, as today).
   - Otherwise success.
   - Jev error/timeout/malformed answer for the request: `neutral`, `[Audit Degraded]` (unchanged, fail open). A malformed answer for one judgement's keys degrades only that judgement (builder's call whether to simplify to whole-request degrade; whole-request is acceptable for v1).
5. One remediation comment (same hidden marker, edited in place), one section per failing judgement: heading with the judgement name, **Why** (teaching), **Fix**, and the signals line. When nothing fails the comment is left as today (not deleted).
6. Check summary lists each judgement and its result.

### What changes in the repo

- `src/types.ts`: `Judgement`, `JudgementVerdict`, config types; `Verdict` reasons become per-judgement.
- `src/judgements/` (new): `one-way-door.ts` (moved logic), `declarative.ts` (generic decider), `registry.ts` (built-ins by id).
- `src/config.ts` (new): fetch, cache, parse, validate, fall back.
- `src/jev.ts`: request builder takes questions from judgements; response parser is generic.
- `src/policy.ts`, `src/comment.ts`: reduced to aggregation and rendering; per-judgement text lives in judgements.
- `src/handler.ts`: orchestrates the above.
- `src/github.ts`: `getFileContents`, a small helper.
- `scripts/mock-github.mjs`, `scripts/scenarios.mjs`: serve a config file and add scenarios for the example judgement.
- `examples/judgement-gate.yml` (new), `README.md` (config docs, Contents: read permission, CODEOWNERS recommendation), `wrangler.toml` (`CONFIG_REPO`).
- `test/gate.test.ts`: existing tests stay green unchanged; new tests for config parsing/validation, fallback, `applies_to`, `satisfied_by`, multi-judgement aggregation and comment rendering.

## Calls I made (flag any you disagree with)

- Org-level `.github` repo as the config home, default branch only.
- YAML (not JSON/TOML) and the `yaml` package.
- No new built-in judgement; the API-contract example ships as `examples/judgement-gate.yml` and is exercised in tests.
- `satisfied_by` is mandatory for declarative judgements.
- Invalid config falls back to built-ins with a note rather than failing the check.
- Single combined comment and single check run.
- 60s Cache API cache for config.
- A judgement named in `use:` that is unknown counts as invalid config.

## Left to the builder

- Exact TypeScript shapes and file layout within the structure above.
- Glob implementation (small hand-written matcher is fine; no heavy dependency).
- Whether Jev's alpha API has a limit on question count; verify with `npm run jev-smoke` using a multi-judgement request and, if limited, cap/queue judgements and document it.
- Wording of the config-error note and the multi-judgement comment layout.

# Pluggable Judgements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hardcoded one-way-door check into a pluggable "judgement" unit, with extra judgements declared in YAML in the org's `.github` repo.

**Architecture:** A `Judgement` (questions + decide + remedy) is produced either by code (the built-in `one-way-door`) or compiled from YAML. The handler loads the org config from the default branch of `<owner>/.github`, runs every applicable judgement in one Jev request with namespaced question keys, and aggregates into the single `judgement-gate` check and single edited-in-place comment.

**Tech Stack:** TypeScript on Cloudflare Workers, vitest, `yaml` npm package (new).

**Spec:** `docs/superpowers/specs/2026-10-19-pluggable-judgements-design.md`

## Global Constraints

- Free-tier Worker: under 10ms CPU, at most 50 subrequests per event; config fetch adds 1 subrequest (0 on cache hit).
- Check name stays `judgement-gate`; comment marker stays `<!-- judgement-gate -->`; shadow/enforce via `MODE`; Jev errors/timeouts give `neutral` titled `[Audit Degraded]`.
- Config path: `.github/judgement-gate.yml` in repo `CONFIG_REPO` (default `.github`) of the PR's owner, read from the **default branch** (no `ref` parameter), never the PR head.
- Declarative judgements require `id`, `name`, `question`, `true`, `false`, `threshold` (0-1), `satisfied_by` (non-empty), `why`, `fix`. `id`s unique. `use:` may only override `confidence_threshold` and `applies_to`.
- `satisfied_by` entry types: `pr_body_matches` (regex, `(?i)` prefix = case-insensitive, max 200 chars) and `file_added` (glob against added/modified/renamed, non-removed files).
- Invalid config falls back to the built-in default list `[one-way-door]` and appends a note to the check summary; it never fails the check.
- New GitHub App permission: Contents: read.
- The 19 existing tests in `test/gate.test.ts` must pass unmodified at the end of every task. Note `fakeNet` there answers any unknown URL (including the config fetch) with HTTP 500, so a non-404 config fetch failure must fall back to built-ins.
- `caches` (Cache API) does not exist under vitest/node; guard with `typeof caches !== "undefined"`.

## Review Focus

- Config fetch returns 404, 403 or 500 (or the `.github` repo isn't in the installation): built-in judgement runs, PR is not blocked; 500/403 add a note. (Task 4)
- YAML that parses but is empty, has no `judgements:` key, or has `judgements: []`: default built-ins, no error note. (Task 3)
- Bad YAML, unknown `use:`, duplicate `id`, bad regex, missing `satisfied_by`: fall back with a note. (Task 3/4)
- Every judgement's `applies_to` misses all changed files: Jev is not called and the check passes "No applicable judgements". (Task 2/4)
- Jev response lacks one of the namespaced answers: whole request degrades to `neutral`, no crash. (Task 2)

Deviations from the spec (decided while planning): `src/policy.ts` stays as the one-way-door decision function (`evaluatePolicy`, `hasAdr`) because existing tests import it; `judgements/one-way-door.ts` wraps it. `judgements: []` is treated like an absent key. The aggregate `Verdict.reason` type widens to `string`.

---

### Task 1: Judgement types, glob matcher, built-in one-way-door

**Files:**
- Modify: `src/types.ts`
- Create: `src/glob.ts`, `src/judgements/one-way-door.ts`
- Test: `test/judgements.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  ```ts
  export interface JevQuestion { type: "noul" | "choice"; instructions: string; criteria: Record<string, string> }
  export type JevAnswers = Record<string, { noul?: number; choice?: string; confidence?: number }>;
  export interface JudgementVerdict { conclusion: "success" | "failure"; reason: string; summary: string; signals?: string }
  export interface RemedyContext { owner: string; repo: string; headRef: string }
  export interface Judgement {
    id: string; name: string; appliesTo?: string[];
    questions: Record<string, JevQuestion>;
    decide(answers: JevAnswers, pr: PrContext): JudgementVerdict;
    remedy(v: JudgementVerdict, rc: RemedyContext): { why: string; fix: string };
  }
  ```
  and `Verdict.reason` widened to `string`.
- Produces: `matchesGlob(pattern: string, filename: string): boolean` and `appliesToFiles(appliesTo: string[] | undefined, files: ChangedFile[]): boolean` in `src/glob.ts`; `oneWayDoor(opts?: { confidenceThreshold?: number; appliesTo?: string[] }): Judgement` in `src/judgements/one-way-door.ts` (default threshold 0.75).

- [ ] **Step 1: Write failing tests** in `test/judgements.test.ts`:
  - `matchesGlob("services/api/**","services/api/v1/x.ts")` true; `matchesGlob("services/api/**","services/web/x.ts")` false; `matchesGlob("docs/api-changes/*.md","docs/api-changes/a.md")` true; `matchesGlob("docs/*.md","docs/a/b.md")` false; `matchesGlob("**/*.sql","a/b/c.sql")` true and `("**/*.sql","c.sql")` true; `matchesGlob("a?c","abc")` true.
  - `appliesToFiles(undefined, files)` true; `appliesToFiles(["x/**"], [{filename:"y.ts",status:"added"}])` false.
  - `oneWayDoor().decide(answers, pr)` returns `reason: "type1_no_adr"`/`conclusion: "failure"` for `is_one_way_boundary_mutation.noul=0.96` (other answers: additive 0.1, reversal 0.1, `synthetic_classification` choice `TYPE_1_ONE_WAY_DOOR` confidence 0.8) with no ADR file in `pr.files`; `success`/`type1_adr` with an added `docs/decisions/0001-x.md`; `success`/`type2_ok` for one-way 0.02, additive 0.9, reversal 0.9, `TYPE_2_TWO_WAY_DOOR`, confidence 0.9; `ambiguous` for confidence 0.5; `oneWayDoor({confidenceThreshold: 0.4})` makes the confidence-0.5 case `type2_ok`.
  - `oneWayDoor().remedy(...)` for `type1_no_adr` has `fix` containing `docs/decisions/` and a `https://github.com/o/r/new/` link; for `type2_no_plan` `fix` contains `Reversal Trigger:` and `Rollback Path:`.
- [ ] **Step 2:** Run `npx vitest run test/judgements.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the types above in `src/types.ts`, `src/glob.ts` (translate glob to RegExp: `**/` = zero or more directories, `**` = anything, `*` = no slash, `?` = one non-slash char, escape the rest), and `oneWayDoor` in `src/judgements/one-way-door.ts`. Move the four questions verbatim from `src/jev.ts` `buildRequest` into `questions` (keep their keys). `decide` maps answers to a `JevResult`, calls `evaluatePolicy` from `src/policy.ts`, and returns its verdict plus `signals` = the existing signals sentence from `src/comment.ts`. Treat `neutral` from policy as impossible (policy only returns success/failure). `remedy` returns `why`/`fix` using the existing text from `src/comment.ts` for `type1_no_adr`, `type2_no_plan` and the default (ambiguous) case; `why` is the "What triggered this" sentence, `fix` the "Fix" content. Do not delete the old code in `jev.ts`/`comment.ts` yet.
- [ ] **Step 4:** Run `npx vitest run` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: judgement types, glob matcher, built-in one-way-door"`

### Task 2: Generic Jev request and handler orchestration (built-in only)

**Files:**
- Modify: `src/jev.ts`, `src/handler.ts`, `src/comment.ts`, `src/policy.ts` (leave as is unless an import needs it)
- Test: `test/gate.test.ts` (unchanged tests must pass), `test/orchestration.test.ts` (new)

**Interfaces:**
- Consumes: `Judgement`, `JevAnswers`, `appliesToFiles`, `oneWayDoor` from Task 1.
- Produces:
  - `buildRequest(ctx: PrContext, model: string, judgements: Judgement[])` in `src/jev.ts`: same `state` as today; `questions` = every judgement's questions keyed `${judgement.id}.${key}`.
  - `evaluate(ctx: PrContext, judgements: Judgement[], cfg: JevConfig, fetchFn: FetchFn): Promise<Record<string, JevAnswers>>` — answers per judgement id with the namespace stripped. Throws `Error("Jev response missing expected answers")` if any asked question has no answer (a `noul` question needs a numeric `noul`; a `choice` question needs `choice`). Timeout/HTTP error behavior unchanged (`JevTimeout`).
  - `renderComment(items: { judgement: Judgement; verdict: JudgementVerdict }[], rc: RemedyContext): string` in `src/comment.ts`: starts with `COMMENT_MARKER`; heading `### judgement-gate: <summary>` when one item fails, else `### judgement-gate: N judgements need attention`; per item a `#### <name>` section with `**Why:**`, `**Fix:**` and a `<sub>` signals line. Remove the old `remediationComment`.
  - `aggregate(results: { judgement: Judgement; verdict: JudgementVerdict }[]): Verdict` (in `src/handler.ts` or a new `src/aggregate.ts`): any failure → `failure`, `reason` and `summary` of the first failing item; all success → `success`, reason/summary of the first item; empty list → `{success, reason: "no_applicable", summary: "No applicable judgements"}`.

- [ ] **Step 1: Write failing tests** in `test/orchestration.test.ts`:
  - `buildRequest` with two stub judgements `a` (question key `q`) and `b` (key `q`) yields keys `a.q` and `b.q`.
  - `evaluate` returns `{a: {q: {noul: 0.2}}, b: {q: {noul: 0.9}}}` for a fake Jev response containing `answers: {"a.q": {noul:0.2}, "b.q": {noul:0.9}}`.
  - `evaluate` rejects with message containing `missing expected answers` when `b.q` is absent.
  - `renderComment` with one failing item contains the marker, `**Why:**`, `**Fix:**`; with two failing items contains `2 judgements need attention` and both `#### ` names.
  - `aggregate([])` equals the `no_applicable` verdict above.
- [ ] **Step 2:** Run `npx vitest run test/orchestration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above. In `processPullRequest`: build `judgements = [oneWayDoor({ confidenceThreshold: Number(env.CONFIDENCE_THRESHOLD ?? 0.75) })]` (hard-wired for now), filter with `appliesToFiles`; if none apply, skip Jev; otherwise call `evaluate`, run each `decide(answers[j.id], ctx)`, `aggregate`, post `renderComment` for failing items (same best-effort comment handling and shadow/enforce logic as today), and keep the `catch` that completes the check as `neutral` `[Audit Degraded]` returning reason `degraded`. The check summary lists each judgement name with its result on its own line. The Jev contract for `jev-smoke` must keep working: update `scripts/jev-smoke.mjs` if it imports `buildRequest`.
- [ ] **Step 4:** Run `npx vitest run` and `npm run typecheck`. Expected: all 19 original tests plus new ones pass without editing `test/gate.test.ts`.
- [ ] **Step 5: Commit** `git commit -am "refactor: run judgements through generic Jev request and aggregation"`

### Task 3: Config parsing, validation, declarative judgements

**Files:**
- Create: `src/config.ts`, `src/judgements/declarative.ts`, `src/judgements/registry.ts`
- Modify: `package.json` (add dependency `yaml`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Judgement`, `oneWayDoor`, `matchesGlob`, `appliesToFiles`.
- Produces:
  - `class ConfigError extends Error` in `src/config.ts`.
  - `parseConfig(text: string, defaults: { confidenceThreshold: number }): Judgement[]` in `src/config.ts`. Throws `ConfigError` (message names the offending judgement/field) for: YAML syntax errors, non-object root, `judgements` not a list, unknown `use:`, a `use:` entry with disallowed override keys, duplicate ids, missing/mistyped required declarative fields, `threshold` outside 0-1, empty `satisfied_by`, unknown `satisfied_by` entry type, regex that is over 200 chars or doesn't compile. Returns the default list (`[oneWayDoor(defaults)]`) when the text is empty, has no `judgements` key, or `judgements: []`.
  - `builtinById(id: string, overrides: { confidence_threshold?: number; applies_to?: string[] }, defaults): Judgement | undefined` in `src/judgements/registry.ts` (only `one-way-door` registered).
  - `compileDeclarative(spec: DeclarativeSpec): Judgement` in `src/judgements/declarative.ts`. One question, local key `q`, type `noul`, `criteria: { true, false }`. `decide`: flag when `answers.q.noul >= threshold`; flagged and no `satisfied_by` entry satisfied → `failure`, reason `${id}_unsatisfied`, summary `${name}: not satisfied`; otherwise `success`, reason `${id}_ok`. `signals` = `${name} ${pct}% (threshold ${pct}%)`. `remedy` returns the YAML `why`/`fix`. `pr_body_matches` tests `pr.body` with flags `m` (+`i` when the pattern starts with `(?i)`, which is stripped); `file_added` matches any file with status other than `removed` against the glob.

- [ ] **Step 1: Write failing tests** in `test/config.test.ts` using the example from the spec (`public-api-contract`):
  - parsing the spec example yields judgements with ids `["one-way-door","public-api-contract"]`; `confidence_threshold: 0.5` on `use: one-way-door` is applied (a confidence-0.6 answer set gives `type2_ok`).
  - declarative `decide`: noul 0.7 + body `"Migration Plan: x"` → success `public-api-contract_ok`... (satisfied) ; noul 0.7 + body `"nope"` + no files → failure `public-api-contract_unsatisfied`; noul 0.59 → success; noul exactly 0.6 → flagged; `file_added: "docs/api-changes/*.md"` satisfied by an added matching file but not by a `removed` one; body `"migration plan: x"` is satisfied (case-insensitive via `(?i)`).
  - `appliesTo` set from `applies_to`.
  - empty string, `"# comment only"`, `"judgements: []"`, `"other: 1"` all return a single `one-way-door`.
  - each of these throws `ConfigError`: `"judgements: ["`, `"judgements: {}"`, `use: nope`, duplicate ids, `threshold: 1.5`, missing `satisfied_by`, `satisfied_by: []`, `satisfied_by: [{ bogus: 1 }]`, regex `"("`, regex of 201 chars, `use: one-way-door` with `threshold: 0.5` (disallowed override).
- [ ] **Step 2:** Run `npx vitest run test/config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** `npm install yaml`, then implement the signatures above. Use `YAML.parse`; wrap its errors in `ConfigError`.
- [ ] **Step 4:** Run `npx vitest run` and `npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: parse and validate judgement YAML, declarative judgements"`

### Task 4: Load config from GitHub and wire into the handler

**Files:**
- Modify: `src/github.ts`, `src/config.ts`, `src/handler.ts`, `src/types.ts` (`Env.CONFIG_REPO?: string`), `wrangler.toml`
- Test: `test/loading.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `ConfigError`.
- Produces:
  - `GitHubClient.getFileContents(owner: string, repo: string, path: string): Promise<string | null>` — `GET /repos/{owner}/{repo}/contents/{path}` with `Accept: application/vnd.github.raw+json`, **no `ref` query**; returns `null` on 404; throws on other non-OK statuses.
  - `loadJudgements(gh: GitHubClient, owner: string, env: Env): Promise<{ judgements: Judgement[]; note?: string }>` in `src/config.ts`. Reads text via a 60s Cache API entry keyed `https://judgement-gate.invalid/config/${owner}` when `typeof caches !== "undefined"` (store the text, or empty string for 404). `null`/empty → defaults, no note. `ConfigError` → defaults, `note` = `Config error: <message>; fell back to built-in judgements.` Fetch failure (non-404) → defaults, `note` = `Could not read judgement config (<message>); fell back to built-in judgements.`
  - Handler: replace the hard-wired list with `loadJudgements(...)`; append `note` (if any) to the final check summary, in shadow, enforce and degraded paths.
  - `wrangler.toml`: add `CONFIG_REPO = ".github"` with a comment.

- [ ] **Step 1: Write failing tests** in `test/loading.test.ts` (reuse the `makeEnv`/`prEvent`/`fakeNet` style from `test/gate.test.ts`, extended with a `.github` contents route so the fake can return a configurable status/body):
  - 404 → same result as today (type1 without ADR fails), summary contains no `Config error`.
  - 500 and 403 → still evaluates with the built-in, final summary contains `fell back to built-in judgements`.
  - the config request URL is `https://gh.test/repos/o/.github/contents/.github/judgement-gate.yml` with no `ref=` and uses `CONFIG_REPO` when set.
  - invalid YAML → built-in runs, summary contains `Config error`, check is not `neutral` and not an exception.
  - config with `public-api-contract` (applies_to `services/api/**`) and a PR touching only `src/a.ts` → Jev request body has no `public-api-contract.q` key.
  - config where every judgement has an unmatched `applies_to` → Jev is never called, conclusion `success`, summary contains `No applicable judgements`.
  - PR touching `services/api/v1.ts` with body `"nope"`, Jev answering `public-api-contract.q` noul 0.9 and one-way-door answers benign → `failure`, one comment containing `Public API contract change`; same PR with body `Migration Plan: x` → `success`.
  - one-way-door fails and public-api-contract fails together → one comment containing `2 judgements need attention`.
  - Jev response missing `public-api-contract.q` → `neutral`, `[Audit Degraded]`.
- [ ] **Step 2:** Run `npx vitest run test/loading.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4:** Run `npx vitest run` and `npm run typecheck`. Expected: all pass, original `test/gate.test.ts` untouched.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: load judgements from the org .github repo"`

### Task 5: Example config, demo scripts, docs

**Files:**
- Create: `examples/judgement-gate.yml`
- Modify: `scripts/mock-github.mjs`, `scripts/scenarios.mjs`, `README.md`

- [ ] **Step 1:** `examples/judgement-gate.yml`: the spec's example (use `one-way-door` plus `public-api-contract`).
- [ ] **Step 2:** `scripts/mock-github.mjs`: serve `/repos/*/.github/contents/.github/judgement-gate.yml` as raw text from `process.env.MOCK_CONFIG ?? "examples/judgement-gate.yml"` (404 if the file is missing). `scripts/scenarios.mjs`: add scenario 5 (touches `services/api/v1/users.ts`, body without plan → expected FAILURE + API-contract comment) and scenario 6 (same files, body with `Migration Plan: ...` → SUCCESS). Note: running scenarios 1-4 against the example config also proves `applies_to` skips the API judgement.
- [ ] **Step 3:** `README.md`: add a "Judgements" section (what a judgement is, the YAML schema table, built-in `one-way-door`, `applies_to`/`satisfied_by`, org `.github` repo location, default-branch rule, CODEOWNERS recommendation, fallback behaviour), add **Contents: read** to the GitHub App permissions list (and note the `.github` repo must be in the installation and orgs must accept the permission update), update the scenario table to include 5 and 6, and update the test count.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck`, and `node scripts/mock-github.mjs` briefly to confirm the config route returns the example (curl `http://localhost:8788/repos/acme/.github/contents/.github/judgement-gate.yml`, expect the YAML), then stop it. Real Jev (`npm run jev-smoke` / `simulate`) requires `OPENROUTER_API_KEY`; if unavailable, say so in the final report rather than claiming it ran.
- [ ] **Step 5: Commit** `git add -A && git commit -m "docs: judgement config example, demo scenarios, README"`

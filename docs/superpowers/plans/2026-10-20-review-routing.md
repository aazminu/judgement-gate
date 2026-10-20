# Review Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `human`/`agent` review-routing recommendation, driven by an optional `routing:` block in the org config, surfaced as a sticky PR label, a check-summary line, analytics, and a field in the hidden agent block.

**Architecture:** Judgement verdicts gain a `fired` flag and judgements expose their possible reason codes. A new pure module (`src/routing.ts`) evaluates `human_when` rules against verdicts and changed files. `src/config.ts` parses the `routing:` block separately from `judgements:` so a routing error never discards judgements. The handler computes routing after the verdicts, applies the label in enforce mode only, and never lets routing change the check conclusion.

**Tech Stack:** TypeScript on a Cloudflare Worker, `yaml` package, vitest. Run `npm test` and `npm run typecheck` (tsc includes `test/`).

**Spec:** `docs/superpowers/specs/2026-10-20-review-routing-design.md`. Read it first; this plan only adds the decisions the spec leaves to the implementer.

## Global Constraints

- The `judgement-gate` check conclusion is identical with and without routing, in every mode and on every failure path.
- Default label `needs-human-review`; a configured `label` is a non-empty string of at most 50 characters.
- `routing:` keys are exactly `include_defaults` (default `true`), `label`, `human_when`. Unknown keys anywhere in `routing:` are a config error.
- `human_when` entries are exactly one of `{judgement}`, `{judgement, reason}`, `{files: [globs]}`. Entries are OR'd.
- Built-in default entries: `{judgement: one-way-door}` and `{judgement: one-way-door, reason: ambiguous}`.
- `files:` rules match any changed file of any status (a removed file counts), using `matchesGlob` from `src/glob.ts`.
- The label is only ever added, never removed (no DELETE call is ever made).
- No extra Jev calls. At most one extra GitHub request per PR (the label POST), only when routing is `human` and routing mode is enforce.
- Routing mode is `env.ROUTING_MODE`, defaulting to `env.MODE`, defaulting to `"shadow"`. Anything other than `"shadow"` is enforce, matching how the check treats `MODE`.
- The hidden-block schema number stays `1`; `routing` is an additive field.
- Routing text (reasons) contains only config ids, globs, reason codes and numbers, never PR title, body or diff.
- Baseline is 114 passing tests. All existing tests must still pass; edit an existing test only to add the new required fields to its stubs.

## Review Focus

Failure modes the spec implies that no single task's main tests would otherwise cover. Each has a test in the task noted.

1. A typo in a `routing:` key (`human-when:`) must route to `human`, not silently to `agent`. (Tasks 3, 5)
2. An empty `routing:` key (YAML null) behaves like an absent block: defaults on. (Task 3)
3. A deleted file still matches a `files:` rule. (Task 2)
4. A label API failure (403/422/500) must not fail or alter the check. (Task 5)
5. During a Jev outage a `files:` rule still labels the PR, while judgement-based rules are skipped. (Task 5)

---

### Task 1: `fired` on verdicts and `reasons` on judgements

**Files:**
- Modify: `src/types.ts`, `src/judgements/one-way-door.ts`, `src/judgements/declarative.ts`
- Modify (stubs only): `test/orchestration.test.ts`, and any other test that tsc flags
- Test: `test/judgements.test.ts` (append)

**Interfaces:**
- Produces: `JudgementVerdict.fired: boolean` (required) and `Judgement.reasons: string[]` (required, every reason code `decide` can return).

- [ ] **Step 1: Write the failing tests** in `test/judgements.test.ts`, describe `"fired and reasons"`:
  - `it.each` over `oneWayDoor().decide(answers, pr)` (answers shaped as in `test/loading.test.ts`'s `type1`/`benign`, pr files as noted): `(oneWay .9, TYPE_1 conf .8, src file)` → reason `type1_no_adr`, `fired` true; same plus an added `docs/decisions/0001-x.md` → `type1_adr`, true; `(oneWay .05, TYPE_2, conf .5)` → `ambiguous`, false; `(oneWay .05, TYPE_2, conf .9, reversal .9)` → `type2_ok`, false; same with reversal `.1` → `type2_no_plan`, false. Each case also asserts `oneWayDoor().reasons` contains the verdict's reason.
  - `expect(oneWayDoor().reasons).toEqual(["type1_adr", "type1_no_adr", "ambiguous", "type2_ok", "type2_no_plan"])`.
  - Declarative via `compileDeclarative` (threshold 0.6, `satisfiedBy: [{ pr_body_matches: /^Plan:/m }]`, id `x`): p 0.9 and body without a plan → failure, `fired` true; p 0.9 and body `Plan: y` → success, `fired` true; p 0.2 → success, `fired` false. `reasons` equals `["x_unsatisfied", "x_ok"]`.
- [ ] **Step 2: Run** `npx vitest run test/judgements.test.ts` — expect FAIL (`fired`/`reasons` undefined).
- [ ] **Step 3: Implement.** Add the two required fields to `JudgementVerdict` and `Judgement` in `src/types.ts`. `oneWayDoor`: `fired` is `v.reason` starting with `type1`; `reasons` is the list above. `compileDeclarative`: `fired` is `p >= spec.threshold`; `reasons` is `[`${id}_unsatisfied`, `${id}_ok`]`. Add `fired: false` / `reasons: []` to the stubs flagged by `npm run typecheck` (at least the `stub` and `fail` helpers in `test/orchestration.test.ts`).
- [ ] **Step 4: Run** `npm run typecheck && npm test` — expect all green (114 + new).
- [ ] **Step 5: Commit** `feat: judgements expose fired verdicts and their reason codes`

### Task 2: Routing evaluation (pure)

**Files:**
- Create: `src/routing.ts`
- Test: `test/routing.test.ts` (new)

**Interfaces:**
- Consumes: `JudgementResult` from `src/aggregate.ts`, `matchesGlob` from `src/glob.ts`, `ChangedFile` from `src/types.ts`.
- Produces, all exported from `src/routing.ts`:
  ```ts
  export const DEFAULT_LABEL = "needs-human-review";
  export type RoutingRule = { judgement: string; reason?: string } | { files: string[] };
  export const DEFAULT_RULES: RoutingRule[];
  export type RoutingSetup =
    | { status: "ok"; rules: RoutingRule[]; label: string }
    | { status: "config_error"; message: string; label: string }
    | { status: "unavailable"; message: string; label: string };
  export interface RoutingResult { route: "human" | "agent" | "unavailable"; reasons: string[]; label: string }
  export function evaluateRouting(setup: RoutingSetup, results: JudgementResult[] | null, files: ChangedFile[]): RoutingResult;
  ```
  `results === null` means the audit was degraded: only `files:` rules can be evaluated.

- [ ] **Step 1: Write the failing tests** in `test/routing.test.ts` (build results with a helper `res(id, reason, fired, probability?)` returning `{ judgement: <minimal Judgement with that id>, verdict }`), `setup = { status: "ok", rules: DEFAULT_RULES, label: DEFAULT_LABEL }`:
  - Type 1 with ADR (`one-way-door`, `type1_adr`, fired) → `route: "human"`, `reasons` equal `["one-way-door flagged"]`.
  - `ambiguous` (fired false) → human, reasons `["one-way-door: ambiguous"]`.
  - `type2_ok` and `type2_no_plan` (not fired) → `route: "agent"`, `reasons: []`.
  - Rule `{judgement: "api"}` with `api` fired false → agent; with `api` absent from results (skipped) → agent, no throw.
  - `{files: ["migrations/**"]}` with files `[{filename: "migrations/001.sql", status: "removed"}]` → human, reasons `["files: migrations/**"]` (review focus 3).
  - `{files: [...]}` matches with `results: []` (no judgement ran) → human.
  - Two matching rules → both reasons present, no duplicates.
  - `results: null`: a `files:` match → human; only judgement rules present → `route: "unavailable"` with `reasons: ["audit degraded"]`; `files:` rule present but not matching → the same `unavailable` result.
  - `config_error` setup → human, reasons `["config error: <message>"]`, label from setup. `unavailable` setup → `route: "unavailable"`, reasons `[<message>]`.
- [ ] **Step 2: Run** `npx vitest run test/routing.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `src/routing.ts`.** A `{judgement}` rule matches when a result with that id has `verdict.fired`; with `reason` it matches when that result's `verdict.reason` equals it, fired or not. Reason strings are exactly: `"<id> flagged"`, `"<id>: <reason>"`, `"files: <first matching glob>"`.
- [ ] **Step 4: Run** `npx vitest run test/routing.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat: pure review-routing evaluation`

### Task 3: Parse `routing:` and load it with the config

**Files:**
- Modify: `src/config.ts`, `src/handler.ts` (rename the call only)
- Test: `test/config.test.ts` (append)

**Interfaces:**
- Consumes: `RoutingSetup`, `RoutingRule`, `DEFAULT_RULES`, `DEFAULT_LABEL` from `src/routing.ts`; `Judgement.reasons`.
- Produces from `src/config.ts`:
  ```ts
  export function parseRouting(raw: unknown, judgements: Judgement[]): { rules: RoutingRule[]; label: string }; // throws ConfigError
  export function parseGateConfig(text: string, defaults: BuiltinDefaults): { judgements: Judgement[]; routing: RoutingSetup };
  export async function loadGateConfig(gh: GitHubClient, owner: string, env: Env, now?: number): Promise<{ judgements: Judgement[]; routing: RoutingSetup; note?: string }>;
  ```
  `parseConfig` keeps its signature and behaviour (returns `parseGateConfig(...).judgements`) except that the top-level key `routing` is now accepted. `loadGateConfig` replaces `loadJudgements` (only `handler.ts` uses it).

- [ ] **Step 1: Write the failing tests** in `test/config.test.ts`:
  - `parseConfig(SPEC_EXAMPLE + "\nrouting:\n  label: x\n", defaults)` does not throw (top-level key accepted).
  - `parseGateConfig` cases (`routing.status`, then `rules`/`label`): no `routing:` key → `ok`, rules equal `DEFAULT_RULES`, label `needs-human-review`; `routing:` empty (YAML null) → same as absent (review focus 2); `routing: { human_when: [{files: ["infra/**"]}] }` → rules are `DEFAULT_RULES` followed by that entry; `include_defaults: false` with one entry → only that entry; `include_defaults: false` with no entries → `rules: []`; `label: "ready-for-people"` is used.
  - `it.each` invalid routing blocks → `routing.status === "config_error"`, `message` matches the regex, and `judgements` still equals the valid parsed list (not the fallback): unknown key `human-when` (`/human-when/`); entry with two keys (`/exactly one/`); entry `{judgement: "nope"}` (`/unknown judgement "nope"/`); `{judgement: "one-way-door", reason: "ambigous"}` (`/unknown reason "ambigous"/`); `{files: []}` (`/non-empty/`); `{files: ["a", 3]}`; `include_defaults: "no"` (`/boolean/`); `label: ""`; `label` of 51 characters (`/50/`); `human_when` not a list.
  - Broken YAML (`"judgements: ["`) → `parseGateConfig` throws `ConfigError`.
  - `loadGateConfig` with a fake `gh = { getFileContents }` cast to `GitHubClient` (call `clearConfigCache()` in `beforeEach`, `env` a minimal `Env`): `null` file → routing `ok` with default rules and no `note`; throwing `getFileContents` → judgements are the fallback, `note` contains `fell back`, routing `status: "unavailable"` with a non-empty `message`; invalid YAML text → fallback judgements, `note`, routing `status: "config_error"`.
- [ ] **Step 2: Run** `npx vitest run test/config.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `src/config.ts`. Refactor `parseConfig` into `parseGateConfig`: one YAML parse, root and unknown-top-level-key checks now allow `judgements` and `routing`, judgements built exactly as today (their errors still throw), then `parseRouting(doc.routing, judgements)` inside a `try` that turns a `ConfigError` into `{ status: "config_error", message, label: DEFAULT_LABEL }`. `doc.routing` null/undefined and `doc.judgements` fallback cases return `ok` defaults. `parseRouting` validates against the judgement list actually in force and against `judgement.reasons`, and prepends `DEFAULT_RULES` unless `include_defaults` is `false`. In `loadGateConfig` mirror `loadJudgements`: read failure → built-in judgements, the existing note text, `unavailable` (message: `"config could not be read"`); 404 → `parseGateConfig("", defaults)`; `ConfigError` → built-in judgements, existing note text, `config_error` carrying the error message. In `src/handler.ts` change only the import and call to `loadGateConfig`, destructuring `routing` unused for now.
- [ ] **Step 4: Run** `npm run typecheck && npm test` — expect green.
- [ ] **Step 5: Commit** `feat: parse and load the routing block separately from judgements`

### Task 4: `routing` field in the hidden agent block

**Files:**
- Modify: `src/comment.ts`
- Test: `test/agent-block.test.ts` (append)

**Interfaces:**
- Consumes: `RoutingResult` from `src/routing.ts`.
- Produces: `renderComment(failing, rc, mode = "shadow", routing?: RoutingResult): string`. When `routing` is given, the JSON payload gains `routing: { route, reasons, label }`; when omitted the payload is byte-identical to today's.

- [ ] **Step 1: Write the failing tests** using that file's `parseBlock`: with `routing = { route: "human", reasons: ["one-way-door flagged"], label: "needs-human-review" }`, `parseBlock(renderComment(failing(...), rc, "enforce", routing)).data.routing` equals that object; without the argument `data` has no `routing` key and `schema` is `1`.
- [ ] **Step 2: Run** `npx vitest run test/agent-block.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** by threading the optional argument into `agentBlock` and spreading `routing` into the payload only when present.
- [ ] **Step 4: Run** `npx vitest run test/agent-block.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat: report routing in the hidden agent block`

### Task 5: Handler integration

**Files:**
- Modify: `src/handler.ts`, `src/github.ts`, `src/analytics.ts`, `src/types.ts`, `wrangler.toml`
- Test: `test/routing-handler.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2-4.
- Produces:
  - `GitHubClient.addLabels(owner: string, repo: string, pr: number, labels: string[]): Promise<void>` — `POST /repos/{owner}/{repo}/issues/{pr}/labels` with body `{ labels }`.
  - `Env.ROUTING_MODE?: string`.
  - `AnalyticsEvent.event` gains `"routing"`; `outcome` gains `"human" | "agent" | "unavailable"`. A routing event has `judgement: ""`, `mode` = the routing mode, `reason` = `reasons.join("; ")` truncated to 256 characters.

- [ ] **Step 1: Write the failing tests** in `test/routing-handler.test.ts`. Copy the `makeEnv`, `prEvent`, `fakeNet` pattern from `test/loading.test.ts` (config body and Jev answers configurable; add a route for `POST .../issues/7/labels` returning 200, with an option to make it return a given status; record every call). Helpers: `labelCalls = calls.filter(c => c.method === "POST" && c.url.endsWith("/issues/7/labels"))`, `finalCheck`. Env `MODE: "enforce"` unless noted. Cases:
  - Type 1 answers (`type1` from `test/loading.test.ts`), file `docs/decisions/0001-x.md` added, no config (404): check `success`; exactly one label call with body `{ labels: ["needs-human-review"] }`; summary contains `Review routing: human (one-way-door flagged)`.
  - Benign answers, plain source file: no label call; summary contains `Review routing: agent`.
  - `ROUTING_MODE: "shadow"` with `MODE: "enforce"` and Type 1 answers: no label call; summary contains `[Shadow] Review routing: would have routed to a human`. And `MODE: "shadow"` alone behaves the same.
  - Config with a typo `routing:\n  human-when: []` and benign answers (review focus 1): label call made, summary contains `config error`, check conclusion still reflects only the judgements (success).
  - Config read failing with 500: no label call, summary contains `Review routing: unavailable`.
  - Config whose only judgement is a declarative one with `applies_to: ["services/api/**"]`, plus `routing: { human_when: [{files: ["migrations/**"]}] }`; the PR changes only `migrations/9.sql` with `status: "removed"`. No judgement applies, so there is no Jev call, and a label call is still made.
  - Label endpoint returns 403 (review focus 4): `processPullRequest` resolves, final check `conclusion` and `title` equal those of an otherwise identical run where the label endpoint succeeds, and the summary contains `Could not add the review label`.
  - Jev returns 500 (review focus 5), config with a `files: ["infra/**"]` rule and file `infra/main.tf`: final check `neutral` with title `[Audit Degraded]`, one label call, summary contains `Review routing: human`. Same Jev 500 with only default rules: no label call, summary contains `Review routing: unavailable`.
  - Conclusion invariance: run the same PR (Type 1, no ADR) with no `routing:` block and with `routing: { include_defaults: false }`; the final check `conclusion` is `failure` in both while only the first calls the label endpoint.
  - No DELETE call is made in any of the above (assert across all recorded calls once, in a shared `afterEach` or inside each case).
  - With a failing judgement (Type 1 without ADR), the posted remediation comment's hidden block has `routing.route === "human"`.
  - Analytics: with a recording sink, a Type 1 run writes one data point whose `blobs[0]` is `"routing"`, `blobs[3]` the routing mode, `blobs[4]` `"human"`.
- [ ] **Step 2: Run** `npx vitest run test/routing-handler.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
  - `src/github.ts`: `addLabels`. `src/types.ts`: `ROUTING_MODE`. `src/analytics.ts`: the new event and outcome values; update the row-layout comment (no new columns).
  - `src/handler.ts`: declare `let routingSetup: RoutingSetup | undefined` and the changed `files` outside the `try` so the degraded path can use them. After `aggregate`, compute `routing = evaluateRouting(setup, results, files)`, then call a new local function `publishRouting(routing, ...)` before the comment is posted and before `completeCheckRun`. It records the analytics event, and when `routing.route === "human"` and routing mode is enforce calls `gh.addLabels(...)` inside its own try/catch, returning the summary text: `Review routing: human (<reasons joined with "; ">)`, `Review routing: agent`, `Review routing: unavailable (<first reason>)` (for a degraded audit that is `audit degraded`); in shadow `[Shadow] Review routing: would have routed to a human (<reasons>)` for human; and when a label call throws, append `Could not add the review label: <message>`. Append that text to the check summary (after `detail`, before `configNote`). Pass `routing` to `renderComment`. In the `catch` (degraded) path compute `evaluateRouting(routingSetup ?? { status: "unavailable", message: "audit degraded", label: DEFAULT_LABEL }, null, files)`, run `publishRouting`, and append its text to the degraded summary. `publishRouting` must never throw. Routing never feeds `aggregate` or the conclusion.
  - `wrangler.toml`: add a commented `# ROUTING_MODE = "shadow"` line under `MODE` explaining the default.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. If an existing handler test now fails only because of the added label call or summary line, add a labels route to that test's `fakeNet` rather than loosening its assertion. Expect all green.
- [ ] **Step 5: Commit** `feat: route PRs to human or agent review and label them`

### Task 6: Mock server, example config and docs

**Files:**
- Modify: `scripts/mock-github.mjs`, `examples/judgement-gate.yml`, `README.md`, `docs/configuration.md`, `docs/agents.md`, `docs/calibration.md`
- Test: `test/config.test.ts` already parses `examples/judgement-gate.yml?raw`; extend that test to assert the example's routing block parses to `status: "ok"`.

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1-5.

- [ ] **Step 1: Extend the example-config test** to call `parseGateConfig(exampleYaml, defaults)` and assert `routing.status === "ok"` and that `routing.rules` contains `{ files: ["migrations/**"] }`. Run `npx vitest run test/config.test.ts` — expect FAIL.
- [ ] **Step 2: Update `examples/judgement-gate.yml`** with a commented `routing:` block (label, `include_defaults`, a `judgement` entry for `public-api-contract`, a `reason: ambiguous` entry, and `files: ["migrations/**", "infra/**"]`). Run the test — expect PASS.
- [ ] **Step 3: `scripts/mock-github.mjs`:** handle `POST /issues/(\d+)/labels`, log `LABEL added on #n: <names>`, respond 200 with `[]`. Verify with `node --check scripts/mock-github.mjs`.
- [ ] **Step 4: Docs.**
  - `README.md`: a short "Review routing" section (what it is, that it recommends and never changes the check, the label, `ROUTING_MODE`, that the label write needs the Issues read & write permission the app already has); update the scenario table so scenario 2 reads "SUCCESS, routed to a human (label `needs-human-review`)" and scenarios 3-4 note "routed to an agent".
  - `docs/configuration.md`: the `routing:` key table (`include_defaults`, `label`, `human_when` entry forms), the built-in defaults, "routing errors route to human and never change your judgements", "unreadable config or audit outage: nothing labelled except `files:` rules", and the two ways to enforce (CODEOWNERS by path; a small workflow that fails until a human approves when the label is present, with the caveat "as far as we know, rulesets and CODEOWNERS cannot require approval conditionally on a label"). Do not add a workflow file to the repo.
  - `docs/agents.md`: the `routing` field of the hidden block (`route`, `reasons`, `label`; present only when a remediation comment is posted).
  - `docs/calibration.md`: the `routing` event (blob1 `routing`, blob5 `human`/`agent`/`unavailable`, blob6 the joined reasons) and a note to watch the human rate in shadow mode before enforcing.
- [ ] **Step 5: Run** `npm run typecheck && npm test` — expect all green (114 + new tests).
- [ ] **Step 6: Commit** `docs: review routing config, label and enforcement options`

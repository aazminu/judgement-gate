# Review routing: design

## Intent

judgement-gate decides whether a PR carries the evidence its risk demands (an ADR for a one-way door, a reversal plan for a two-way door). It does not say **who should review the PR**. Agents now write and review a growing share of PRs, and the judgements already know which changes are risky: a one-way door (Type 1) codifies a decision that is hard or impossible to undo, so a person who can be held accountable must look at it. A reversible change can be reviewed by an agent.

So the gate gets a second output next to its verdict: a **routing recommendation**, `human` or `agent`, with the reasons. The owner of the org config says which conditions require a human, in the same YAML file and the same vocabulary as judgements. The gate recommends; the repo's own rules enforce.

Why the ADR does not replace the human: the ADR check confirms that a file exists under `docs/decisions/`. The hidden block in every failing comment tells an agent exactly how to clear a failure, so an agent can write an ADR to turn the check green. Presence of an ADR is weak evidence that an accountable person accepted the decision. The ADR is the paper trail a human reviewer reads, not a substitute for the reviewer.

## Goals

- Every evaluated PR gets a routing result: `human` or `agent`, plus the list of reasons.
- Owners declare the conditions that require a human in an optional `routing:` block in `.github/judgement-gate.yml`, same file and same trust model as judgements.
- Without any config, the built-in default applies: a `one-way-door` Type 1 result, or an ambiguous one, routes to a human.
- The `judgement-gate` check conclusion is **unchanged**. Type 1 with an ADR still goes green; Type 1 without one still fails. Routing never changes pass/fail.
- A `human` result is visible to the repo: a PR label (default `needs-human-review`), a line in the check summary, and, when a remediation comment is posted, a `routing` field in its hidden JSON block.
- No extra Jev calls. Routing is computed from the answers already fetched.

## Non-goals (v1)

- `agent_when` carve-outs ("docs-only PRs go to an agent even if flagged"). Add later if usage shows the need.
- Requesting specific reviewers or teams. The gate only labels.
- Shipping the enforcement mechanism. Enforcement is the repo's job: CODEOWNERS by path (always on, model-independent), or a small workflow in the repo that fails until a human approves whenever the label is present. As far as we know GitHub rulesets and CODEOWNERS cannot require approval conditionally on a label, hence the workflow. Document both options; ship neither.
- Removing the label. The gate adds it and never removes it (see anti-goals).
- Routing by who or what authored the PR (bot vs person).
- Per-repo routing config. Org-level only, like judgements.

## Anti-goals (would be a failure even if it technically works)

- A PR can change the rules that route it. Routing config is read from the **default branch** only, never the PR head.
- The gate lets an author lose the human requirement by pushing again. The label is sticky: once added it stays until a human removes it. If the gate removed the label when a later push classified as harmless, an agent could push a flagged version, then an innocuous one, and shed the requirement.
- A bad or unreadable routing config silently routes PRs to an agent.
- Routing changes the check's pass/fail, or a routing failure (label API error) fails the check.
- Routing text leaking PR or diff content. Reasons are built from config ids, globs, reason codes and numbers only.

## Constraints

- Cloudflare Worker, free tier: under 10ms CPU, at most 50 subrequests per event. A PR event costs 4-5 GitHub subrequests today (plus 1 for config on a cache miss). Routing adds at most 1 (the label call), and only when the result is `human`.
- The app already has Issues: read & write, which covers adding labels to a PR. No new GitHub permission is expected. The README must still state that the label write needs it.
- Existing tests, `scripts/mock-github.mjs` and `scripts/simulate.mjs` keep working. The mock gains the label endpoint.
- Jev alpha API, 2.5s timeout, fail-open behaviour: unchanged.

## Design

### Verdict gets a `fired` field

Routing needs to know that a judgement **flagged the change** regardless of whether the author cleared it. Today a cleared Type 1 comes back as `success`, so the verdict alone says "fine". `JudgementVerdict.metrics.cleared` carries part of this but is documented as calibration-only.

Add `fired: boolean` to `JudgementVerdict` as a first-class field, set by each judgement:

- `one-way-door`: `fired` is true when the reason is `type1_adr` or `type1_no_adr` (the policy's Type 1 branch). It is false for `ambiguous`, `type2_ok` and `type2_no_plan`.
- Declarative: `fired` is true when the probability is at least the judgement's `threshold`, whether or not a `satisfied_by` entry cleared it.

`metrics.cleared` keeps its calibration role. Aggregation and the check conclusion do not read `fired`.

### Routing config

Optional top-level `routing:` key in `.github/judgement-gate.yml`:

```yaml
judgements:
  - use: one-way-door
  - id: public-api-contract
    # ...

routing:
  include_defaults: true           # optional, default true
  label: needs-human-review        # optional, default shown
  human_when:                      # optional list; any matching entry routes to a human
    - judgement: public-api-contract        # that judgement fired
    - judgement: one-way-door
      reason: ambiguous                     # that judgement returned this reason code
    - files: ["migrations/**", "infra/**"]  # any changed file matches
```

Rules:

- `human_when` entries are OR'd. Each entry is exactly one of:
  - `{ judgement: <id> }`: matches when that judgement ran and its verdict has `fired: true`.
  - `{ judgement: <id>, reason: <code> }`: matches when that judgement ran and its verdict `reason` equals the code, fired or not. This is how to target `ambiguous`.
  - `{ files: [<glob>, ...] }`: matches when any changed file matches any glob, using the existing matcher (`*`, `**`, `?`), regardless of file status (a deleted migration counts). This works even when no judgement was applicable, so path rules are the model-independent floor.
- A `judgement` entry must name an id present in the loaded `judgements` list, otherwise it is a config error. A judgement skipped by its `applies_to` simply does not match.
- A `reason` must be a code the named judgement can produce, otherwise it is a config error (a typo like `ambigous` must not silently route to an agent). Each `Judgement` therefore exposes its set of possible reason codes: `type1_adr`, `type1_no_adr`, `ambiguous`, `type2_ok`, `type2_no_plan` for `one-way-door`; `<id>_unsatisfied` and `<id>_ok` for a declarative judgement.
- If the `judgements:` section itself fell back to the built-ins, `judgement:` entries are validated against the list actually in force.
- **Built-in default entries** (applied when `include_defaults` is true or omitted, and when there is no `routing:` block at all): `{judgement: one-way-door}` and `{judgement: one-way-door, reason: ambiguous}`. They are added to the owner's entries, so writing a `routing:` block never drops them by accident. `include_defaults: false` is the explicit opt-out. If `one-way-door` is not in the loaded judgements the default entries match nothing.
- Unknown keys anywhere in `routing:` are a config error, like the rest of the file. The top-level key check in `parseConfig` must now accept `routing` alongside `judgements`.
- `label`: a non-empty string of at most 50 characters (GitHub's limit).

Result shape (internal, names are guidance):

```ts
interface RoutingResult {
  route: "human" | "agent";
  reasons: string[];   // e.g. ["one-way-door: Type 1 (probability 0.92, confidence 0.86)", "files: migrations/**"]
  label: string;
}
```

### Evaluation flow

1. Load config. `loadJudgements` grows into a loader that also returns the parsed routing rules.
2. Judgements run exactly as today.
3. Routing is evaluated after the verdicts exist. It runs even when no judgement applied (files rules still work).
4. Outputs, depending on the routing mode. Routing has its own optional setting, `ROUTING_MODE` (`shadow` or `enforce`), which defaults to `MODE`. That lets a team that already enforces the check pilot routing in shadow, or the reverse:
   - **Enforce**: if `route` is `human`, add the label to the PR (one idempotent POST to the issue labels endpoint; the builder may skip it when the PR payload already lists the label). The gate never removes the label.
   - **Shadow**: do not touch the PR. The check summary says "would have routed to a human" and analytics still records the result. This mirrors how the check itself behaves in shadow mode.
   - Both modes: the check summary gets a line, for example `Review routing: human (one-way-door: Type 1)`, or `agent`. Analytics gets one routing data point per PR (outcome `human`/`agent`, reasons joined), following the existing `record()` pattern.
5. If a remediation comment is being posted (some judgement failed), its hidden JSON block gains a `routing` field: `{ "route": "human"|"agent", "reasons": [...], "label": "..." }`. The schema number stays at 1 (additive field) and `docs/agents.md` documents it. When nothing fails no comment is posted and none is added just for routing: the label and the summary line carry the result. This means the hidden-block field is visible only on PRs that also have a failing judgement.

### Failure behaviour

- **Config absent (404):** built-in default routing, no note.
- **`routing:` block invalid** (unknown key, bad entry, unknown judgement id, unknown reason code, bad label): the `routing:` block is parsed and validated **separately** from `judgements:`. A routing error never touches the judgements: the owner's valid judgements keep running and the check conclusion is unchanged. Only routing is affected: it becomes `human` with reason `config_error`, and the summary says why. The label is applied (in enforce mode) because the error is persistent and the owner needs to notice it.
- **YAML syntax error or schema error elsewhere in the file:** nothing in the file can be trusted. Judgements fall back to the built-ins with a note, as today, and routing becomes `human` with reason `config_error`, labelled in enforce mode.
- **Config could not be read** (GitHub 5xx, network, missing Contents permission): judgements fall back with a note, as today. Routing is reported as unavailable in the summary and **no label is applied**, like an audit outage. A transient hiccup must not leave a sticky label on every PR opened in that window across the org. Without the owner's rules there is nothing model-independent to apply (the built-in defaults are judgement-based).
- **Label API error** (permission, 403, 422, network): never fails the check. Append a note to the check summary, like `commentNote` today.
- **Audit degraded** (Jev timeout, 5xx, malformed answer): the check stays `neutral` and fails open as today. Judgement-based routing rules cannot be evaluated, so they are skipped. Model-independent rules still run: `files:` entries and a `config_error` result still route to `human` and still label. The summary says that judgement-based routing was unavailable. This is why the routing evaluation is structured so the `files:` and config checks can run without verdicts, including from the degraded path.

### What changes in the repo

- `src/types.ts`: `fired` on `JudgementVerdict`; `RoutingResult` and routing config types.
- `src/judgements/one-way-door.ts`, `src/judgements/declarative.ts`: set `fired`.
- `src/routing.ts` (new): config types, `evaluateRouting(results, files, rules)`, the built-in default entries.
- `src/config.ts`: accept the `routing` key at the top level. Parse and validate it separately from the judgements, so a routing error cannot discard the judgements. Return the routing rules (or a `config_error` marker) with the judgements.
- `wrangler.toml`, `src/types.ts` (`Env`): optional `ROUTING_MODE`, defaulting to `MODE`.
- `src/github.ts`: `addLabels(owner, repo, pr, labels)`.
- `src/handler.ts`: evaluate routing after the verdicts, apply the label in enforce mode, add the summary line, record analytics, handle the degraded and error paths above.
- `src/comment.ts`: `routing` field in the hidden block.
- `src/analytics.ts`: a routing event if the record type needs one.
- `scripts/mock-github.mjs`, `scripts/scenarios.mjs`: serve the labels endpoint; add scenarios (Type 1 with ADR routes to human and is labelled, a reversible PR routes to an agent).
- `examples/judgement-gate.yml`, `README.md`, `docs/configuration.md`, `docs/agents.md`: document the `routing:` block, the label, shadow-mode behaviour and the two ways to enforce.
- Tests: `fired` for both kinds of judgement; routing rule matching (each entry type, defaults on and off, skipped judgement, files rule with no applicable judgements, deleted file); config parsing and every `routing:` validation error; config-error route to human; degraded path applies no label; shadow mode applies no label but reports it; enforce adds the label; label API failure leaves the check unchanged; the check conclusion is identical with and without routing; sticky label (no removal call ever made); hidden-block `routing` field.

## Known limits

- Routing to an agent depends on the model not under-classifying a real one-way door. A Type 1 change the judge calls Type 2 goes to an agent. The `files` rules and the ambiguous-goes-to-human default reduce the risk; calibration data (`docs/calibration.md`) shows how often it happens.
- A flood of false Type 1 flags becomes a flood of human reviews. Watch the routing analytics in shadow mode before enforcing.

## Calls I made (flag any you disagree with)

- Defaults stay unless the owner sets `include_defaults: false`; that key name is my choice.
- Invalid config (a bad `routing:` block or a broken file) routes to `human` and labels. A `routing:` error never changes the owner's judgements.
- An unreadable config (GitHub 5xx, missing permission) and an audit outage (Jev down) fail open for judgement-based routing: nothing is labelled because of them. Model-independent rules (`files:`, `config_error`) still apply during an outage. This is a refinement of "bad config routes to human": a transient read failure should not leave sticky labels across the org.
- Shadow mode never labels; it reports and records. Routing has its own `ROUTING_MODE` setting that defaults to `MODE`.
- Unknown `reason:` codes are config errors; each judgement exposes the codes it can produce.
- The label is added, never removed.
- `reason:` entries match on the verdict reason code whether or not the judgement fired; bare `judgement:` entries match only on `fired`.
- A `judgement:` entry naming an unknown id is a config error.
- The hidden-block `routing` field appears only when a remediation comment is posted.
- Routing results do not change the check conclusion in any mode.

## Left to the builder

- Exact types and file layout within the structure above.
- Whether to skip the label POST when the PR payload already carries it.
- Wording of the summary line and of the config-error note.
- How to extend the analytics record type for the routing event.
- Whether `loadJudgements` is extended or a sibling loader is added, as long as `parseConfig` callers in existing tests keep working.

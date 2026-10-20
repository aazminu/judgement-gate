# Severity: design

Step 2 of the teaching-gate roadmap (`claude/llm-jev-gating-messages-3901b6:docs/superpowers/specs/2026-10-20-teaching-gate-roadmap-design.md`). Built on top of review routing.

## Intent

`one-way-door` measures reversibility: can we undo this? Severity is a separate question: how bad is it if this change is wrong? A reversible change to checkout can be P0; an irreversible change to an internal admin table can be P3. Teaching juniors to keep those two questions apart is part of the point of the gate.

Companies disagree on what P0 and P1 mean, so the org writes the rubric in its YAML. The gate has no built-in rubric: a generic P0 to P3 would be invented.

Severity **informs and never fails**. A declarative judgement flags at a threshold and is cleared by `satisfied_by`; severity has nothing for an author to clear, so making it fail would be a judgement that can never be satisfied (an anti-goal in the pluggable-judgements spec). It is a classifier: one `choice` question to Jev, a level out, conclusion always `success`.

## YAML

A third judgement kind, next to `use:` (built-in) and the yes/no declarative. It is identified by the `classify` key.

```yaml
- id: severity
  name: Severity
  classify:
    question: "If this change is wrong, how bad is the impact?"
    levels:                          # ordered, most severe first
      - id: P0
        means: "customer-facing outage, data loss, or security exposure"
      - id: P1
        means: "major feature broken for many users, no workaround"
  applies_to: ["services/**"]        # optional, same semantics as today
```

Names kept as proposed. `levels` is a list so order is explicit and numeric-looking ids cannot be reordered by JS object key rules.

Validation (existing style, `ConfigError`, bad config falls back to the built-in with a note, routing is still validated separately):

- Entry keys are exactly `id`, `name`, `classify`, optional `applies_to`. Anything else is an error, so `threshold` or `satisfied_by` on a classifier is rejected rather than ignored.
- `id` kebab-case, not a built-in id; duplicate judgement ids rejected (existing check).
- `classify` keys are exactly `question` and `levels`.
- At least 2 levels. Each level has exactly `id` and `means`, both non-empty strings.
- Level `id`: 1 to 32 characters, letters, digits, `.`, `_`, `-`, starting with a letter or digit (`P0`, `Sev1`, `S-1`). Free-form: nothing assumes a `P` prefix. Unique ignoring case (so `P1` and `p1` cannot both exist). A bare YAML number (`id: 1`) is rejected with the same message as any non-string; quote it.

## Compiled judgement

`compileClassifier` (`src/judgements/classifier.ts`) returns a `Judgement` with:

- one question, `q`, type `choice`, `instructions` = the question, `criteria` = `levelId -> means` in the configured order. Sent as `${id}.q` in the same single Jev request.
- `kind: "classifier"` (new optional field) so routing config and the summary can tell it apart.
- `reasons: ["${id}_classified", "${id}_unreported"]`.
- `optionalAnswers: true` (see below).
- `decide`: always `conclusion: "success"`, `fired: false`. If Jev's answer names a configured level (matched ignoring case and surrounding whitespace, returned as the configured spelling) the verdict is `${id}_classified` with `classification: { level, confidence? }`, summary `Severity: P1`. Otherwise `${id}_unreported`, no classification, summary `Severity: no level reported`.
- `remedy` is required by the interface but unreachable: a classifier never fails, so it is never rendered.

Because `decide` only ever emits a configured level id, the level in the agent block and analytics is config text, never model or PR text.

## Verdict type

`JudgementVerdict` gains `classification?: { level: string; confidence?: number }`. `fired` stays required and is `false` for a classifier. `aggregate()` is not touched: severity is a `success` result like any other. Consequence worth knowing: severity alone yields the check title `Severity: P1`; with other passing judgements the title is `N judgements passed`; a failing judgement always supplies the title and reason.

## A bad severity answer must not take down the others

`evaluate()` throws if any answer is missing or malformed, and the handler turns that into a degraded (neutral) check for the whole PR. For severity that is the wrong trade: a classifier that cannot classify should say so, not hide the one-way-door verdict.

Chosen: a new optional `Judgement.optionalAnswers`. In `evaluate()`, when a judgement sets it, an invalid or missing answer is left out of that judgement's answers instead of throwing. Everything else about validation is unchanged. Severity's `decide` then sees no `q` and returns `severity_unreported`. A level that is well-formed but not one of the configured ids is handled in `decide` the same way. One generic flag, no severity knowledge in `jev.ts`, nothing changes for judgements that do not set it. Rejected alternatives: catching in the handler (cannot distinguish severity's failure from a real one without the same flag), and wrapping `decide` (the problem is in `evaluate`, before `decide`).

A Jev HTTP error, timeout, or non-JSON body still degrades the whole request as today: that is an outage, not a bad answer.

## Where it shows up

- **Check summary:** `- pass: Severity (P1)`; `- pass: Severity (no level reported)` when unreported. The handler special-cases `kind === "classifier"` for the parenthesised text; other judgements are unchanged.
- **Remediation comment:** only when it is already posted for a failing judgement. `renderComment` takes the full result list as an extra trailing parameter and adds one line per classification under the heading: `**Severity:** P1 (confidence 0.82)`. Severity alone never causes a comment (`failing` is still the only trigger).
- **Agent block:** additive top-level `classification: [{ id, level, confidence }]` (`confidence` is `null` when absent). Present only when at least one judgement classified, so blocks for configs without a classifier are byte-identical to today. `schema` stays 1. Only ids, a configured level id and a number: no PR or diff content.
- **Analytics:** the existing `evaluation` event for the classifier carries `outcome: passed`, `reason: ${id}_classified` or `_unreported`, `confidence` in `double4`. The level goes in a new trailing `blob8`, written only when a level exists so existing rows keep their exact shape. `probability` is `-1`.

## Routing interaction (no change to routing)

Routing is untouched. A classifier never fires, so a bare `judgement: severity` rule can never match. A typo-like config that can never match is the situation the routing design already rejects ("a typo cannot quietly send PRs to an agent"), so **a bare `judgement:` entry naming a classifier is a config error** (routing `config_error`, judgements unaffected), with a message pointing at the alternatives. `judgement: severity` with `reason: severity_unreported` is allowed and meaningful: "route to a human when severity could not be determined". `reason: severity_classified` is allowed but matches whenever the classifier ran; documented as pointless rather than rejected.

This is the only adaptation to the brief; it rests on the routing validation rule, not on a collision.

## Calls made, as given

- Separate YAML kind, not an extension of declarative.
- Low confidence: level and confidence are reported; no auto-escalation.
- Level ids free-form.
- No default rubric; example in `examples/judgement-gate.yml`.

## Follow-up note: severity as a routing input (not built)

The clean way, when step 3 wants it: add a routing entry form `{ severity: [P0, P1] }` (a list of level ids, validated against the classifier's configured levels, like `judgement:` ids are validated today), matched against `verdict.classification.level` in `matchRule`. It stays a lookup with no model call. The pieces it needs already exist: the classification on the verdict, the configured ids on the judgement (it would need to expose `levels`), and the `severity_unreported` reason for the "unsure means human" default. Deliberately not added here.

## Non-goals and anti-goals

As in the brief: no routing input, no acting on the level, no per-level thresholds, no generated explanations, no per-repo config. Severity never fails a PR; a bad severity answer never degrades the others; no PR or diff content in the agent block; no change to one-way-door, routing or existing configs.

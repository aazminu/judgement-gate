# Teaching gate: roadmap (reversibility, severity, review routing)

Status: roadmap and decisions so far. Step 1 is not yet specified. Steps 2 and 3 have enough to build from, noted below. Each step gets its own plan before any code.

## Intent

judgement-gate already stops risky PRs and tells the author how to clear the gate. It does that with fixed text, so it feels generic and teaches little. The aim is to extend it in two directions at once:

- **Scale judgement.** Let a team write down how it judges a change (can we undo it? how bad if it is wrong? who should review it?) and apply that to every PR, whether a person or an agent wrote it. This is what a linter does for style, extended to business impact.
- **Grow judgement.** Do not let that automation become a layer that hides the skill. A junior who is accountable for a change should come away better at spotting the issues, not only better at clearing the gate.

The tension to hold: instructions that are fast to follow, and learning that still requires the engineer to think. A gate that works too well can stop people developing the habit of weighing tradeoffs.

## Who reads the gate's output

Two readers, with different needs. Both matter.

- **The coding agent** needs a fast, complete, unambiguous path. The gate keeps global context (the team's codified judgement) that an agent focused on one issue cannot see. The agent's output must not be slowed.
- **The engineer** is the one accountable and the one who should learn. They need a short, specific explanation of why the gate fired on this diff, and the questions a senior would ask.

This two-layer structure already exists: human prose (Why and Fix) and a hidden JSON block for agents, both produced in `src/comment.ts`.

## The model: two measurements and one policy

1. **Reversibility (type 1 or type 2).** Can we undo this? Exists today as the built-in `one-way-door`.
2. **Severity (for example P0 to P3).** How bad is it if this change is wrong? A separate question: a reversible change to checkout can be P0; an irreversible change to an internal admin table can be P3. The company defines its own levels. Teaching juniors to separate these two questions is part of the learning goal.
3. **Review routing (human or agent).** Not an independent axis. It is the company's policy applied to the first two, a lookup table. No model is involved in the lookup.

Both measurements go to Jev in the same request. There is no ordering between them; only the routing step reads both results.

## Goals

- Severity is a company-defined rubric, expressed in the existing org YAML, labelling each PR.
- Routing is a company-defined table over (reversibility, severity), expressed in the same YAML, producing a recommendation.
- The gate's explanation reads the diff and the verdict, builds on the rule a senior wrote, and teaches rather than only instructs.
- Everything stays inside the current architecture: stateless Worker, org config read from the default branch, fail-open.

## Non-goals

- Enforcing review routing. The judge recommends; the organisation's own machinery (branch protection, CODEOWNERS, rulesets) enforces. (Decided with the project owner.)
- A UI, database or new state.
- Severity or routing acting on their own to block a PR.
- Replacing human judgement with a smarter checklist.

## Anti-goals (a failure even if it technically works)

- A message so specific and convincing that people follow it without thinking. The gate should pose the tradeoff questions; the engineer must still write the answers.
- An explanation that quietly lets the agent absorb the lesson while the human learns nothing.
- Severity or routing that can never be satisfied or that blocks a hotfix on a model outage.
- Untrusted diff text flowing into a block an agent will obey (prompt injection).
- Generic text that people learn to skim.

## Constraints

- Cloudflare Worker, free tier. Small CPU budget; subrequests capped per event.
- Jev is an alpha API. It answers yes/no-style (`noul`) and `choice` questions; it does not write prose. Its confidence score is not a calibrated probability (see README).
- The gate fails open: a model outage never blocks a PR.
- The agent block carries ids, reason codes, numbers and templates only: never PR text or diff content (docs/agents.md).
- Privacy: any additional model call sends diff content to another model provider. README's data section must be updated if so.

## Step 1: teaching message (not yet specified)

Direction agreed:

- Keep the layers. The **agent layer stays deterministic** (templates and structured hints, as today). This avoids prompt injection and keeps the no-diff-content invariant.
- Generated text is confined to the **human layer**.
- It builds on the senior-authored `why` (the codified judgement), saying how it applies to this diff. It does not replace it.
- It aims to point at the signal in the diff and ask the questions a senior would ask, not hand over the finished ADR or plan.
- A second model call is needed (Jev cannot write prose). It runs after the verdict, is best-effort, and falls back to the static text on any failure or timeout.

Open, needs the project owner's input before this can be built:

- What a good senior would point at in the diff, and which questions they would ask, for type 1 changes (for example a schema migration) and type 2 changes. This is the core of the teaching content and has not been described yet.
- Cost and behaviour on every push: the Worker re-runs on each `synchronize`. Whether to regenerate every time or only when the verdict or relevant diff changes (the Worker is stateless; the Cache API is available).
- Which model and key, and the privacy wording.

## Step 2: severity as a pluggable judgement

Specified; a ready-to-use prompt was written in the design conversation. Summary of the decisions:

- A new **classifier** kind in the org YAML: one `choice` question to Jev, a company-written list of ordered levels, each with a `means` description.
- It cannot fail or block on its own (a classifier has nothing for an author to "clear"; making it fail would repeat the "unsatisfiable judgement" anti-goal).
- The verdict gets an optional, generic classification field (`level`, `confidence`), so step 3 can read it.
- It appears in the check summary, in the comment when one is already being posted (never a comment for severity alone), in the agent block (additive; schema stays 1), and in analytics.
- No built-in default rubric: a generic P0 to P3 definition would be invented. Ship an example in `examples/judgement-gate.yml`.
- A malformed severity answer must not take down the other judgements.
- Low confidence: report the level and confidence; do not auto-escalate in this version.

## Step 3: advisory review routing

Depends on step 2. Decisions so far:

- **Advisory.** The output is a recommendation, for example "Recommended review: human, because type 1 at P1".
- It is shown in the check summary and comment, and in the agent block. An agent that reads `human` should stop and ask for a human review, not self-approve.
- The table lives in the same org YAML, read from the default branch, governed by CODEOWNERS. Cell values come from a small fixed set (for example `agent`, `human`, `senior-human`); it is a lookup, not a scripting language.
- A default cell applies when a label is missing or Jev was unsure. Recommended default: `human`, so uncertainty leans toward more oversight.
- First task of this step: expose `one-way-door`'s type 1 or 2 result as a clean classification, like severity's. Today it mixes classification with evidence-checking (ADR or rollback plan present).
- **Optional label** (for example `review:human`) as the integration point for an org's own rulesets and workflows. This is a guess, not yet confirmed as wanted. Off by default if included. The app already has issues write permission, which covers labels.

## Calls made without the project owner (flag any you disagree with)

- Agent layer deterministic; generated text in the human layer only.
- Severity is a separate classifier kind, not an extension of the yes/no declarative judgement.
- No built-in severity rubric.
- Routing is plain code over a company table, with a default of `human`.
- Optional, off-by-default label for routing.
- Order: teaching message, then severity, then routing. (Teaching message may be built in parallel with severity; routing waits for severity.)

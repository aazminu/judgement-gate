# Explain a human route on a passing PR: design

## Problem

A PR that passes every judgement but routes to a human (a Type 1 change with an ADR, a cleared API break, a `files:` rule match, a config error) gets a label in enforce mode and a line in the check summary, and nothing else. The author is never told in the PR why a person must review it. Today the gate comments only when a judgement fails.

## Behaviour

When no judgement fails and the routing result is `human`, the gate posts one short comment that says why a person reviews the PR. It uses the same marker and `upsertComment` as the failing comment, so there is one gate comment per PR.

| Situation | Comment |
|---|---|
| a judgement fails | the remediation comment, as today |
| nothing fails, route `human` | **new:** routing comment |
| nothing fails, route `agent` or `unavailable` | none, as today |
| audit degraded (the `catch` path) | none, as today: there are no verdicts to say "passed" about |

The comment is posted in shadow routing mode too, with the wording `routingLine` already has for shadow ("no label is added"). The heading is also adjusted so it does not claim a routing that did not happen.

### Content

1. Heading: `judgement-gate: passed the checks, routed to a human reviewer` (shadow routing: `passed the checks, human review recommended`).
2. The existing `**Review routing:**` line (`routingLine`, reasons in code spans) and the severity line(s) already produced from classifier results. These sit under the heading, as in the failing comment.
3. One section per judgement that **fired and was cleared** (`conclusion: "success"` and `fired: true`): the judgement name, its senior-authored `why` (from `remedy`), and its `probes` as "Questions a reviewer will ask". Here the questions are for the human reviewer, not the author. A route caused only by a `files:` rule or a config error has no such section; the routing line carries the reason.
4. The hidden agent block, schema 1, with `failing: []`, `routing`, and `classification` as today. No new field.

No "Not a real issue?" footer: nothing was flagged for the author to dispute.

### Decisions

- **`type1_adr` gets a `why` and probes.** `remedy` has no `type1_adr` case, so a cleared Type 1 would show the `ambiguous` text ("could not confidently size the blast radius"), which is wrong. `remedy` gets a `type1_adr` case ("looks like a one-way door; the ADR records the reasoning, but the change is still hard to undo, so a person who is accountable reviews it"). `probes` returns the Type 1 list for `type1_adr`, so the reviewer sees the same questions the author would have been shown without an ADR. This is safe for the failing path: `type1_adr` is never a failing verdict, so no existing comment or block changes. `type2_ok` still returns none, and it never fires.
- **Which results are "cleared".** `fired && conclusion === "success"`. This is what the router already treats as fired; no new field on the verdict.
- **Replaces the failing comment.** The PR earlier had a failing comment, now passes and routes to a human: `upsertComment` overwrites the body, so the routing text replaces the old text. Never two comments.
- **A comment failure never fails the check.** Same `commentNote` pattern. Rendering happens inside the `try`, so a render error cannot reach the degraded path. The note reads "Could not post the routing comment" for this case.
- **Nothing else moves.** `aggregate`, the check conclusion, title and summary, severity logic, config parsing, rule matching, label behaviour and the sticky-label rule are untouched. No new Jev call and no new GitHub permission (issue comments are already written).

## Observation (not changed here)

A PR that failed earlier and now passes and routes to an **agent** keeps its old failing comment: the gate only writes when something fails or (now) routes to a human. The same holds for a routing comment when a later push routes to an agent: the old text stays. Both are stale-comment cases that pre-date this change in spirit; fixing them means deciding what to write when all is well, which is a separate decision.

## Testing

- Unit (`comment-routing.test.ts`): the routing comment's heading, shadow wording, cleared section with `why` and probes, severity line, hidden block (`failing: []`, `routing`, `classification`), no footer.
- Unit (`judgements.test.ts`): `type1_adr` remedy and probes.
- Handler (`routing-handler.test.ts`): comment posted for Type 1 + ADR in enforce and shadow; for a `files:` rule only; none for `agent` and `unavailable`; replaces an existing failing comment (PATCH, no second POST); a comment failure leaves conclusion, title and summary unchanged (apart from the note); check output identical to the no-comment baseline.
- e2e: scenarios 2 and 6 assert the new comment.

# For AI coding agents

Every remediation comment ends with a hidden block that tells an agent exactly how to clear each failing judgement, so it does not have to parse the prose. The human-readable Why/Fix text is unchanged.

```
<!-- judgement-gate:v1 {"schema":1,"mode":"enforce","failing":[ ... ]} -->
```

One line, an HTML comment (invisible when rendered). Find it with `/<!-- judgement-gate:v(\d+) (\{.*\}) -->/` on the comment that contains `<!-- judgement-gate -->`, then `JSON.parse` group 2. `<` and `>` inside the JSON are escaped as `<`/`>`, so JSON parsing round-trips and nothing can close the comment early. The block carries ids, reason codes, numbers and templates only: never PR text, diffs or secrets.

| Field | Meaning |
|---|---|
| `schema` | Integer, equals the `v` in the marker. Unknown higher versions: fall back to the prose. |
| `mode` | `shadow` (check always passes, but fix it anyway) or `enforce`. |
| `failing[].id`, `.name` | Judgement id and display name. |
| `failing[].reason` | Reason code, e.g. `type1_no_adr`, `type2_no_plan`, `ambiguous`, `<id>_unsatisfied`. |
| `failing[].probability`, `.threshold` | Model probability and flag threshold, or `null`. |
| `failing[].satisfied_by` | Ways to clear it; **any one** is enough (see below). |
| `failing[].suggested_template` | `{target: "pr_body"\|"file", path?, content}` to paste, or `null`. |
| `routing` | Who the gate recommends reviews this PR. Optional: absent from older comments. See below. |
| `routing.route` | `human`, `agent` or `unavailable` (routing could not be decided). |
| `routing.reasons` | Array of short strings, for example `one-way-door flagged`, `one-way-door: ambiguous`, `files: migrations/**`. Built from config ids, globs, reason codes and config-error text, and never contains PR content. Empty for `agent`. |
| `routing.label` | The label the gate adds to a PR routed to a human, default `needs-human-review`. |

`satisfied_by` entries, by `type`:

- `pr_body_matches`: `regex` (and optional `flags`). The PR body must match it.
- `pr_body_fields`: `fields` that must appear as `Name:` lines in the PR body; `template` shows the format.
- `file_added`: add or modify a file matching `glob` (`example_path` is a concrete choice).

Built-in `one-way-door`: `type1_no_adr` → `file_added` `docs/decisions/*.md`; `type2_no_plan` → `pr_body_fields` `Reversal Trigger` and `Rollback Path` (plus `Owner`); `ambiguous` → either of the two.

## Routing

`routing` is added only when a remediation comment is posted, that is, when at least one judgement failed. A PR with no failing judgement gets no comment and so no block; its routing is in the PR label and the check summary. The schema number stays at 1 because the field is additive.

`routing.route` is a recommendation and does not change the check. It reports the result whether or not the label is applied: in shadow routing mode the gate does not label, but the block still shows what it would have done.

If `route` is `human`, clearing a failure does not remove the need for a human. Fixing the judgement turns the check green; a person still reviews the PR. Leave the label alone: the gate never removes it, and only a person should. Say in the PR description what the human should look at.

## How an agent should react

1. Read the gate's comment on your PR and parse the block.
2. For each failing judgement, pick one `satisfied_by` entry. If `suggested_template` fits, fill in the `<placeholders>` with real content (do not leave them in) and either update the PR body or commit the file at `path`.
3. Push or edit; the gate re-runs and edits the same comment in place.
4. If the judgement is wrong for this change, do not game it. Ask a human to reply `/judgement-gate false-positive <id>`.
5. Never satisfy a regex with content that is not true of the change.

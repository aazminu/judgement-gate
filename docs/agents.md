# For AI coding agents

Every remediation comment ends with a hidden block that tells an agent exactly how to clear each failing judgement, so it does not have to parse the prose. The human-readable Why/Fix text is unchanged.

```
<!-- judgement-gate:v1 {"schema":1,"mode":"enforce","failing":[ ... ]} -->
```

One line, an HTML comment (invisible when rendered). Find it with `/<!-- judgement-gate:v(\d+) (\{.*\}) -->/` on the comment that contains `<!-- judgement-gate -->`, then `JSON.parse` group 2. `<` and `>` inside the JSON are escaped as `<`/`>`, so JSON parsing round-trips and nothing can close the comment early. The block carries ids, reason codes, numbers, templates and authored probe questions only: never PR text, diffs or secrets.

| Field | Meaning |
|---|---|
| `schema` | Integer, equals the `v` in the marker. Unknown higher versions: fall back to the prose. |
| `mode` | `shadow` (check always passes, but fix it anyway) or `enforce`. |
| `failing[].id`, `.name` | Judgement id and display name. |
| `failing[].reason` | Reason code, e.g. `type1_no_adr`, `type2_no_plan`, `ambiguous`, `<id>_unsatisfied`. |
| `failing[].probability`, `.threshold` | Model probability and flag threshold, or `null`. |
| `failing[].satisfied_by` | Ways to clear it; **any one** is enough (see below). |
| `failing[].suggested_template` | `{target: "pr_body"\|"file", path?, content}` to paste, or `null`. |
| `failing[].probes` | Questions the author should answer in the ADR or PR description; authored text, never PR content; may be empty. |

`satisfied_by` entries, by `type`:

- `pr_body_matches`: `regex` (and optional `flags`). The PR body must match it.
- `pr_body_fields`: `fields` that must appear as `Name:` lines in the PR body; `template` shows the format.
- `file_added`: add or modify a file matching `glob` (`example_path` is a concrete choice).

Built-in `one-way-door`: `type1_no_adr` → `file_added` `docs/decisions/*.md`; `type2_no_plan` → `pr_body_fields` `Reversal Trigger` and `Rollback Path` (plus `Owner`); `ambiguous` → either of the two.

## How an agent should react

1. Read the gate's comment on your PR and parse the block.
2. For each failing judgement, pick one `satisfied_by` entry. If `suggested_template` fits, fill in the `<placeholders>` with real content (do not leave them in) and either update the PR body or commit the file at `path`. If `probes` is not empty, address each question in the ADR or plan you write, with real content that is true of the change.
3. Push or edit; the gate re-runs and edits the same comment in place.
4. If the judgement is wrong for this change, do not game it. Ask a human to reply `/judgement-gate false-positive <id>`.
5. Never satisfy a regex with content that is not true of the change.

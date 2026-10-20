# Configuring judgements

A judgement is what the gate asks about a change. The Worker sends every applicable judgement to Jev in one request, then posts one check and one comment.

**No config needed.** Without a config file, the built-in `one-way-door` judgement runs. Failure comments show a "Why" and a "Fix", and the check summary lists each judgement.

**Add your own.** Create `.github/judgement-gate.yml` in your organisation's `.github` repo (repo name overridable with `CONFIG_REPO`). Protect it with CODEOWNERS and branch protection that requires Code Owner review on that repo's default branch: whoever approves changes to that file owns the org's judgement. It is always read from the **default branch**, so a PR cannot change the rules that gate it. See [examples/judgement-gate.yml](../examples/judgement-gate.yml).

| Key | Meaning |
|---|---|
| `use` | Enable a built-in (`one-way-door`). Only `confidence_threshold` and `applies_to` may be overridden. |
| `id`, `name` | Unique id (kebab-case) and the name shown in the comment. |
| `question`, `true`, `false` | The yes/no question for Jev, and what each answer means. |
| `threshold` | 0 to 1. Flagged when the probability of "true" is at least this. |
| `applies_to` | Optional globs (`*`, `**`, `?`). Judged only if a changed file matches. Omit for always. |
| `satisfied_by` | Required. Any one entry clears the flag: `pr_body_matches` (regex, `(?i)` prefix for case-insensitive, max 200 chars) or `file_added` (glob on an added or modified file). |
| `why`, `fix` | The remedy shown to the author: why it matters, and what to do. |

**A non-empty list replaces the default.** If you list only your own judgement, `one-way-door` stops running org-wide. Add `- use: one-way-door` to keep it.

## Review routing

Routing is the gate's recommendation of who should review a PR: a `human` or an `agent`. It is computed from the answers the gate already has, so it costs no extra Jev call. It is configured in an optional `routing:` key in the same file, read from the same default branch.

```yaml
routing:
  include_defaults: true           # optional, default true
  label: needs-human-review        # optional, default shown
  human_when:                      # optional; any matching entry routes to a human
    - judgement: public-api-contract
    - judgement: one-way-door
      reason: ambiguous
    - files: ["migrations/**", "infra/**"]
```

| Key | Meaning |
|---|---|
| `include_defaults` | Boolean, default `true`. Keep the built-in rules below in addition to yours. Set `false` to use only your own `human_when` entries. |
| `label` | The PR label added for a `human` result. Non-empty, at most 50 characters. Default `needs-human-review`. |
| `human_when` | A list. Entries are OR'd: any match routes to a human. Each entry has exactly one of the forms below. |

`human_when` entry forms:

- `judgement: <id>`: that judgement ran and **fired**. Fired means it flagged the change, whether or not the author cleared it, so a Type 1 change with an ADR still counts.
- `judgement: <id>` with `reason: <code>`: that judgement ran and returned this reason code, fired or not. This is how to target `ambiguous`. Codes: `type1_adr`, `type1_no_adr`, `ambiguous`, `type2_ok`, `type2_no_plan` for `one-way-door`; `<id>_unsatisfied` and `<id>_ok` for a declarative judgement.
- `files: [<glob>, ...]`: any changed file matches any glob (`*`, `**`, `?`), whatever its status, so a deleted migration counts. This does not depend on the model and works even when no judgement applied.

A judgement that did not run (its `applies_to` matched no changed file) matches nothing. A `judgement:` id must be in the judgements list actually in force, and a `reason:` must be a code that judgement can produce. Otherwise it is a config error, so a typo cannot quietly send PRs to an agent.

**Built-in defaults.** Unless you set `include_defaults: false`, these two entries always apply, with or without a `routing:` block: `judgement: one-way-door` (a Type 1 result) and `judgement: one-way-door` with `reason: ambiguous`. Your entries are added to them. If `one-way-door` is not in your judgements list, the defaults match nothing.

### If the routing config is wrong

A bad `routing:` block (an unknown key, a bad entry, an unknown judgement id or reason code, a bad label) is checked separately from `judgements:`. It never changes your judgements or the check result. Routing becomes `human` with the reason `config error: ...`, the summary says why, and the default label is added in enforce mode, so the owner notices. A YAML or schema error elsewhere in the file has the same routing result, and judgements fall back to the built-in as described below.

When routing cannot be fully decided:

- **The config could not be read** (GitHub 5xx, network, missing Contents permission): judgements fall back to the built-in, the summary reports routing as unavailable, and nothing is labelled. Without your rules there is nothing model-independent to apply, and a short outage should not leave a label on every PR opened in that window.
- **The audit is degraded** (Jev timeout, 5xx, malformed answer): the check stays `neutral`, as always. Judgement-based entries are skipped, but `files:` entries and config errors still route to a human and still label. If none of those apply, the summary says routing is unavailable and nothing is labelled.

If adding the label fails (permissions, API error), the check is unchanged and the summary notes that the label could not be added.

### The label

- It is added in enforce routing mode only. In shadow routing mode the gate does not touch the PR: the summary reads "would have routed to a human" and the result is recorded in analytics.
- It is sticky. The gate adds it and never removes it, so a later push cannot shed the requirement. A person removes it.
- Adding it needs the Issues read & write permission the app already has.
- GitHub creates a missing label with a default colour, so if you want a specific colour, create the label in the repo first.

### Enforcing the review

The gate recommends. Your repo enforces. Two options:

1. **CODEOWNERS, by path.** List the paths that always need a person (for example `migrations/` and `infra/`) in CODEOWNERS and require Code Owner review in branch protection or a ruleset. It does not depend on the model or on this gate.
2. **A small workflow in your repo** that fails until a human has approved whenever the `needs-human-review` label is present, triggered on `pull_request` (`labeled`, `unlabeled`, `synchronize`) and on `pull_request_review`, with that workflow required by a ruleset. As far as we know, rulesets and CODEOWNERS cannot require approval conditionally on a label, hence the workflow. This repo does not ship one.

Before enforcing either, watch the human rate in shadow mode (see [calibration.md](calibration.md#review-routing)).

## If the config is wrong

A missing file, an empty file, or `judgements: []` runs the built-in default. An unknown key (at the top level or inside a judgement, for example a typo like `judgement:` or `applies-to:`) is a config error rather than being ignored. A YAML or schema error, or a config that cannot be read (for example a missing Contents permission), also falls back to the built-in, and the check summary says so. A bad config never blocks a PR.

**Config not picked up?** GitHub answers 404 for a repo the app cannot see, which looks the same as "no config file". If your judgements never run, check that the org's `.github` repo is part of the app installation (not just "selected repositories" without it).

## Cost

At most one extra GitHub request per isolate per 60 seconds. The Worker caches the config in memory within the isolate for 60 seconds (including on `*.workers.dev` domains) and also uses the Cloudflare Cache API as a best-effort second layer on custom domains. A new or changed config can take up to 60 seconds to apply.

## Regex caution

`pr_body_matches` patterns run against PR bodies written by anyone. Keep them simple: a pattern with nested repeats can run for a very long time on a crafted body, which can stop the Worker mid-run and leave the check stuck at "in progress".

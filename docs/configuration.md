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

## If the config is wrong

A missing file, an empty file, or `judgements: []` runs the built-in default. An unknown key (at the top level or inside a judgement, for example a typo like `judgement:` or `applies-to:`) is a config error rather than being ignored. A YAML or schema error, or a config that cannot be read (for example a missing Contents permission), also falls back to the built-in, and the check summary says so. A bad config never blocks a PR.

**Config not picked up?** GitHub answers 404 for a repo the app cannot see, which looks the same as "no config file". If your judgements never run, check that the org's `.github` repo is part of the app installation (not just "selected repositories" without it).

## Cost

One extra GitHub request per event. The Worker also asks the Cloudflare Cache API to hold the config for 60 seconds, but the Cache API does nothing on `*.workers.dev` domains, so budget one request per event unless you deploy on a custom domain. On a custom domain, a new or changed config can take up to 60 seconds to apply.

## Regex caution

`pr_body_matches` patterns run against PR bodies written by anyone. Keep them simple: a pattern with nested repeats can run for a very long time on a crafted body, which can stop the Worker mid-run and leave the check stuck at "in progress".

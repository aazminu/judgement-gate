# Calibration

In shadow mode the gate never blocks, so the useful output is data: how often each judgement flags, how often humans say the flag was wrong, and how confident the model was. This page shows how to read that data and use it to tune thresholds.

## What is recorded

The Worker writes one [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) data point per judgement per evaluation (`event = 'evaluation'`) and one per human reply (`event = 'feedback'`). The `[[analytics_engine_datasets]]` block in `wrangler.toml` binds the dataset `judgement_gate`. Remove the block and nothing is recorded and nothing else changes. A failed write is logged and ignored.

Only ids, numbers and enum strings are stored. Never the PR title, body, diff or commenter identity.

| Column | Meaning |
| --- | --- |
| `index1`, `blob2` | `owner/repo` |
| `blob1` | `evaluation` or `feedback` |
| `blob3` | judgement id |
| `blob4` | `shadow` or `enforce` |
| `blob5` | `flagged`, `passed`, `cleared` (over threshold but satisfied by an ADR or `satisfied_by` rule), `degraded` (Jev failed), `false_positive` |
| `blob6` | verdict reason, such as `type1_no_adr` |
| `blob7` | commenter's `author_association` (feedback only) |
| `double1` | PR number |
| `double2` | flagged, 0 or 1 |
| `double3` | probability the judgement fired on (`-1` if none). For one-way-door this is the one-way boundary probability |
| `double4` | confidence (`-1` if none). For one-way-door this is the classification confidence |
| `double5` | cleared, 0 or 1 |
| `double6` | Jev call latency in ms for the PR (`-1` for feedback) |
| `double7` | degraded, 0 or 1 |

## Marking a false positive

Every remediation comment ends each judgement section with a hint. Anyone who can comment on the PR replies with a line:

```
/judgement-gate false-positive one-way-door
```

The id is the judgement id shown in the config. The Worker logs a `false_positive` event for that PR and judgement. It does not change the check or the comment, and it makes no GitHub calls. This needs the GitHub App to subscribe to **Issue comment** events (README, Deploy step 1). A reply from a bot is ignored. Replying twice counts twice, so count distinct PRs (below).

## Querying

Use the SQL API with an API token that has *Account Analytics: Read*:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $API_TOKEN" \
  --data "SELECT blob3 AS judgement, count() FROM judgement_gate WHERE blob1 = 'evaluation' GROUP BY judgement"
```

Analytics Engine samples at high volume, so use `sum(_sample_interval)` instead of `count()` when volume is large. Data is kept for 3 months.

**Flag rate per judgement**

```sql
SELECT blob3 AS judgement,
       sum(_sample_interval) AS evaluations,
       sum(double2 * _sample_interval) AS flagged,
       sum(double2 * _sample_interval) / sum(_sample_interval) AS flag_rate
FROM judgement_gate
WHERE blob1 = 'evaluation' AND blob5 != 'degraded' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY judgement
```

**False-positive rate per judgement** (flagged PRs that someone disputed, counted by distinct PR)

```sql
SELECT blob3 AS judgement,
       count(DISTINCT double1) AS disputed_prs
FROM judgement_gate
WHERE blob1 = 'feedback' AND timestamp > NOW() - INTERVAL '14' DAY
GROUP BY judgement
```

Divide `disputed_prs` by the flagged count from the first query. Analytics Engine has no joins, so do this by hand or in a script. A low rate may also mean people are not replying, so watch the reply count over time.

**Confidence distribution for flags**

```sql
SELECT blob3 AS judgement,
       round(double4, 1) AS confidence_bucket,
       sum(double2 * _sample_interval) AS flagged
FROM judgement_gate
WHERE blob1 = 'evaluation' AND double4 >= 0
GROUP BY judgement, confidence_bucket
ORDER BY judgement, confidence_bucket
```

Swap `double4` for `double3` to see the probability distribution.

**Jev health**

```sql
SELECT sum(double7 * _sample_interval) / sum(_sample_interval) AS degraded_rate,
       quantileWeighted(0.95)(double6, _sample_interval) AS p95_latency_ms
FROM judgement_gate
WHERE blob1 = 'evaluation'
```

Latency is the same for every judgement in one PR, so this slightly over-weights PRs with many judgements.

## Tuning

1. Run in shadow mode for about two weeks, then pull the flag rate, disputed PRs and confidence distribution per judgement.
2. A judgement with a high flag rate and many disputes is too sensitive. For a declarative judgement raise `threshold`. For one-way-door, `CONFIDENCE_THRESHOLD` turns low-confidence PRs into "ambiguous" flags, so lower it to flag fewer.
3. Compare the confidence or probability buckets of disputed PRs with the rest. If disputes cluster in one band, put the threshold at the top of that band.
4. A judgement that never flags, or never flags above its threshold, may be asking the wrong question. Reword it before raising or lowering anything.
5. Change one judgement at a time, and keep shadow mode on for another week to see the effect. Move to `enforce` only when the disputed share is one you would accept as a blocked merge.
6. A high `degraded_rate` means the data is thin. Fix `JEV_TIMEOUT_MS` or the Jev connection before trusting the rates.

Note that `cleared` rows are PRs the model would have flagged but the author had already satisfied. They show the rule working, not an error.

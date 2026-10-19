import { COMMENT_MARKER } from "./github";
import type { JevResult, Verdict } from "./types";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const FENCE = "```";

export function remediationComment(v: Verdict, j: JevResult, owner: string, repo: string, headRef = "HEAD"): string {
  const signals = `Signals: one-way boundary ${pct(j.oneWayProb)}, additive/isolated ${pct(j.additiveProb)}, reversal plan ${pct(j.reversalProb)}, classified ${j.classification} (confidence ${j.classificationConfidence.toFixed(2)}).`;
  let fix: string;
  switch (v.reason) {
    case "type1_no_adr":
      fix = [
        "**What triggered this:** the change looks like a one-way door (schema, auth or infrastructure).",
        "",
        "**Fix:** add an Architecture Decision Record at `docs/decisions/NNNN-short-title.md` covering context, decision, alternatives, consequences and rollback limits.",
        `[Create one](https://github.com/${owner}/${repo}/new/${headRef}?filename=docs/decisions/0001-title.md).`,
      ].join("\n");
      break;
    case "type2_no_plan":
      fix = [
        "**What triggered this:** a reversible change, but the PR description has no concrete reversal plan.",
        "",
        "**Fix:** add these three lines to the PR description:",
        "",
        FENCE,
        "Reversal Trigger: <signal that tells us to roll back, e.g. error rate > 2% for 5 min>",
        "Rollback Path: <exact steps, e.g. revert this PR, or set flag X=off>",
        "Owner: <who acts on the trigger>",
        FENCE,
      ].join("\n");
      break;
    default:
      fix = [
        "**What triggered this:** the model could not confidently size the blast radius.",
        "",
        "**Fix:** request a human peer review, or document the decision in an ADR under `docs/decisions/`.",
      ].join("\n");
  }
  return `${COMMENT_MARKER}\n### judgement-gate: ${v.summary}\n\n${fix}\n\n<sub>${signals}</sub>`;
}

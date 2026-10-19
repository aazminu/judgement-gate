import type { Judgement, JudgementVerdict, Verdict } from "./types";

export interface JudgementResult {
  judgement: Judgement;
  verdict: JudgementVerdict;
}

/** Any failing judgement fails the gate; the first failure supplies the reason. */
export function aggregate(results: JudgementResult[]): Verdict {
  if (results.length === 0) return { conclusion: "success", reason: "no_applicable", summary: "No applicable judgements" };
  const failed = results.filter((r) => r.verdict.conclusion === "failure");
  if (failed.length === 0) {
    const first = results[0].verdict;
    return { conclusion: "success", reason: first.reason, summary: results.length === 1 ? first.summary : `${results.length} judgements passed` };
  }
  const first = failed[0].verdict;
  return {
    conclusion: "failure",
    reason: first.reason,
    summary: failed.length === 1 ? first.summary : `${failed.length} judgements need attention`,
  };
}

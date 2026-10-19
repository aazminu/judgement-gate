import type { JudgementResult } from "./aggregate";
import { FALSE_POSITIVE_COMMAND } from "./analytics";
import { COMMENT_MARKER } from "./github";
import type { RemedyContext } from "./types";

/** One comment for the PR: a teaching section (why + fix) per failing judgement. */
export function renderComment(failing: JudgementResult[], rc: RemedyContext): string {
  const heading =
    failing.length === 1 ? failing[0].verdict.summary : `${failing.length} judgements need attention`;
  const sections = failing.map(({ judgement, verdict }) => {
    const r = judgement.remedy(verdict, rc);
    const parts = [`#### ${judgement.name}`, "", `**Why:** ${r.why}`, "", "**Fix:**", "", r.fix];
    if (verdict.signals) parts.push("", `<sub>${verdict.signals}</sub>`);
    parts.push("", `<sub>Not a real issue? Reply \`${FALSE_POSITIVE_COMMAND} ${judgement.id}\` to help calibrate.</sub>`);
    return parts.join("\n");
  });
  return `${COMMENT_MARKER}\n### judgement-gate: ${heading}\n\n${sections.join("\n\n")}`;
}

import type { JudgementResult } from "./aggregate";
import { FALSE_POSITIVE_COMMAND } from "./analytics";
import { COMMENT_MARKER } from "./github";
import type { RemedyContext } from "./types";

export const AGENT_BLOCK_VERSION = 1;

/** Escape so the JSON can never close the HTML comment or inject markup. */
const safeJson = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** Hidden, machine-readable twin of the comment. Ids, reasons, numbers and fix templates only: no PR or diff content. */
function agentBlock(failing: JudgementResult[], rc: RemedyContext, mode: string): string {
  const payload = {
    schema: AGENT_BLOCK_VERSION,
    mode,
    failing: failing.map(({ judgement, verdict }) => {
      const hint = judgement.agent?.(verdict, rc);
      return {
        id: judgement.id,
        name: judgement.name,
        reason: verdict.reason,
        probability: verdict.metrics?.probability ?? null,
        threshold: hint?.threshold ?? null,
        satisfied_by: hint?.satisfied_by ?? [],
        suggested_template: hint?.suggested_template ?? null,
      };
    }),
  };
  return `<!-- judgement-gate:v${AGENT_BLOCK_VERSION} ${safeJson(payload)} -->`;
}

/** One comment for the PR: a teaching section (why + fix) per failing judgement. */
export function renderComment(failing: JudgementResult[], rc: RemedyContext, mode = "shadow"): string {
  const heading =
    failing.length === 1 ? failing[0].verdict.summary : `${failing.length} judgements need attention`;
  const sections = failing.map(({ judgement, verdict }) => {
    const r = judgement.remedy(verdict, rc);
    const parts = [`#### ${judgement.name}`, "", `**Why:** ${r.why}`, "", "**Fix:**", "", r.fix];
    if (verdict.signals) parts.push("", `<sub>${verdict.signals}</sub>`);
    parts.push("", `<sub>Not a real issue? Reply \`${FALSE_POSITIVE_COMMAND} ${judgement.id}\` to help calibrate.</sub>`);
    return parts.join("\n");
  });
  return `${COMMENT_MARKER}\n### judgement-gate: ${heading}\n\n${sections.join("\n\n")}\n\n${agentBlock(failing, rc, mode)}`;
}

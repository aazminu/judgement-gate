import type { JudgementResult } from "./aggregate";
import { FALSE_POSITIVE_COMMAND } from "./analytics";
import { COMMENT_MARKER } from "./github";
import type { RoutingResult } from "./routing";
import type { RemedyContext } from "./types";

export const AGENT_BLOCK_VERSION = 1;

/** Escape so the JSON can never close the HTML comment or inject markup. */
const safeJson = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** Hidden, machine-readable twin of the comment. Ids, reasons, numbers and fix templates only: no PR or diff content. */
function agentBlock(failing: JudgementResult[], rc: RemedyContext, mode: string, routing?: RoutingResult, classified: JudgementResult[] = []): string {
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
    ...(classified.length > 0 && {
      classification: classified.map(({ judgement, verdict }) => ({
        id: judgement.id,
        level: verdict.classification!.level,
        confidence: verdict.classification!.confidence ?? null,
      })),
    }),
    ...(routing && { routing: { route: routing.route, reasons: routing.reasons, label: routing.label } }),
  };
  return `<!-- judgement-gate:v${AGENT_BLOCK_VERSION} ${safeJson(payload)} -->`;
}

/**
 * One comment for the PR: a teaching section (why + fix) per failing judgement. `all` is every result; classifiers
 * (severity) among them are reported alongside, never as a reason to post.
 */
export function renderComment(
  failing: JudgementResult[],
  rc: RemedyContext,
  mode = "shadow",
  routing?: RoutingResult,
  all: JudgementResult[] = [],
): string {
  const classified = all.filter((r) => r.verdict.classification);
  const labels = classified.map(({ judgement, verdict }) => {
    const { level, confidence } = verdict.classification!;
    return `**${judgement.name}:** ${level}${confidence === undefined ? "" : ` (confidence ${confidence.toFixed(2)})`}`;
  });
  const heading =
    failing.length === 1 ? failing[0].verdict.summary : `${failing.length} judgements need attention`;
  const sections = failing.map(({ judgement, verdict }) => {
    const r = judgement.remedy(verdict, rc);
    const parts = [`#### ${judgement.name}`, "", `**Why:** ${r.why}`, "", "**Fix:**", "", r.fix];
    if (verdict.signals) parts.push("", `<sub>${verdict.signals}</sub>`);
    parts.push("", `<sub>Not a real issue? Reply \`${FALSE_POSITIVE_COMMAND} ${judgement.id}\` to help calibrate.</sub>`);
    return parts.join("\n");
  });
  return `${COMMENT_MARKER}\n### judgement-gate: ${heading}\n\n${labels.length > 0 ? `${labels.join("  \n")}\n\n` : ""}${sections.join("\n\n")}\n\n${agentBlock(failing, rc, mode, routing, classified)}`;
}

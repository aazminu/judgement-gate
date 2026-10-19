import type { FetchFn, JevResult, PrContext } from "./types";

export class JevTimeout extends Error {}

export interface JevConfig {
  apiKey: string;
  url: string;
  model: string;
  timeoutMs: number;
}

export function buildRequest(ctx: PrContext, model: string) {
  return {
    model,
    state: {
      title: ctx.title,
      description: ctx.body,
      base_branch: ctx.baseBranch,
      changed_files: ctx.files.map((f) => `${f.status} ${f.filename}`),
      diff: ctx.patchExtract,
    },
    questions: {
      is_one_way_boundary_mutation: {
        type: "noul",
        instructions:
          "Does this pull request make a one-way-door change: a persistent database/schema change, an authentication or authorization refactor, or an infrastructure topology shift that cannot easily be undone?",
        criteria: {
          true: "alters persistent schema or data, auth model, or infrastructure topology in a way that is hard to reverse",
          false: "no persistent, auth or infrastructure boundary mutation",
        },
      },
      is_additive_or_isolated: {
        type: "noul",
        instructions: "Is this change strictly additive and non-breaking, or isolated behind an adapter or feature flag?",
        criteria: {
          true: "only adds behaviour, or is guarded by a flag/adapter so existing behaviour is unchanged",
          false: "modifies or removes existing behaviour without a guard",
        },
      },
      has_concrete_reversal_plan: {
        type: "noul",
        instructions:
          "Does the pull request description state BOTH a concrete reversal trigger (an operational signal that says to roll back) AND a rollback procedure?",
        criteria: {
          true: "description names a trigger condition and the steps to roll back",
          false: "no trigger, or no rollback steps, or only vague statements",
        },
      },
      synthetic_classification: {
        type: "choice",
        instructions: "Classify this change as a one-way door (hard to reverse) or a two-way door (easy to reverse).",
        criteria: {
          TYPE_1_ONE_WAY_DOOR: "irreversible, schema-altering, or infrastructure-critical",
          TYPE_2_TWO_WAY_DOOR: "easily reversible by revert or flag flip",
        },
      },
    },
  };
}

interface Answers {
  is_one_way_boundary_mutation?: { noul?: number };
  is_additive_or_isolated?: { noul?: number };
  has_concrete_reversal_plan?: { noul?: number };
  synthetic_classification?: { choice?: string; confidence?: number };
}

export async function evaluate(ctx: PrContext, cfg: JevConfig, fetchFn: FetchFn): Promise<JevResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(ctx, cfg.model)),
      signal: ctl.signal,
    });
  } catch (e) {
    if (ctl.signal.aborted) throw new JevTimeout(`Jev did not respond within ${cfg.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Jev -> ${res.status} ${await res.text()}`);
  const a = ((await res.json()) as { answers: Answers }).answers;
  const cls = a.synthetic_classification;
  if (
    a.is_one_way_boundary_mutation?.noul == null ||
    a.is_additive_or_isolated?.noul == null ||
    a.has_concrete_reversal_plan?.noul == null ||
    !cls?.choice
  ) {
    throw new Error("Jev response missing expected answers");
  }
  return {
    oneWayProb: a.is_one_way_boundary_mutation.noul,
    additiveProb: a.is_additive_or_isolated.noul,
    reversalProb: a.has_concrete_reversal_plan.noul,
    classification: cls.choice === "TYPE_1_ONE_WAY_DOOR" ? "TYPE_1_ONE_WAY_DOOR" : "TYPE_2_TWO_WAY_DOOR",
    classificationConfidence: cls.confidence ?? 0,
  };
}

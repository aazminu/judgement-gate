import { evaluatePolicy } from "../policy";
import type { Judgement, JevAnswers, JevResult, JudgementVerdict } from "../types";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const FENCE = "```";

function toJevResult(a: JevAnswers): JevResult {
  const cls = a.synthetic_classification;
  return {
    oneWayProb: a.is_one_way_boundary_mutation.noul!,
    additiveProb: a.is_additive_or_isolated.noul!,
    reversalProb: a.has_concrete_reversal_plan.noul!,
    classification: cls.choice === "TYPE_1_ONE_WAY_DOOR" ? "TYPE_1_ONE_WAY_DOOR" : "TYPE_2_TWO_WAY_DOOR",
    classificationConfidence: cls.confidence ?? 0,
  };
}

export interface OneWayDoorOptions {
  confidenceThreshold?: number;
  appliesTo?: string[];
}

export function oneWayDoor(opts: OneWayDoorOptions = {}): Judgement {
  const confidenceThreshold = opts.confidenceThreshold ?? 0.75;
  return {
    id: "one-way-door",
    name: "One-way door",
    appliesTo: opts.appliesTo,
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
    decide(answers, pr): JudgementVerdict {
      const j = toJevResult(answers);
      const v = evaluatePolicy(j, pr.files, { confidenceThreshold });
      return {
        conclusion: v.conclusion === "success" ? "success" : "failure",
        reason: v.reason,
        summary: v.summary,
        signals: `Signals: one-way boundary ${pct(j.oneWayProb)}, additive/isolated ${pct(j.additiveProb)}, reversal plan ${pct(j.reversalProb)}, classified ${j.classification} (confidence ${j.classificationConfidence.toFixed(2)}).`,
      };
    },
    remedy(v, rc) {
      switch (v.reason) {
        case "type1_no_adr":
          return {
            why: "The change looks like a one-way door (schema, auth or infrastructure). Once it ships it is hard to undo, so the reasoning behind it must be recorded where the next person will find it.",
            fix: [
              "Add an Architecture Decision Record at `docs/decisions/NNNN-short-title.md` covering context, decision, alternatives, consequences and rollback limits.",
              `[Create one](https://github.com/${rc.owner}/${rc.repo}/new/${rc.headRef}?filename=docs/decisions/0001-title.md).`,
            ].join("\n"),
          };
        case "type2_no_plan":
          return {
            why: "The change is reversible, but only if someone knows when and how to reverse it. The PR description has no concrete reversal plan.",
            fix: [
              "Add these three lines to the PR description:",
              "",
              FENCE,
              "Reversal Trigger: <signal that tells us to roll back, e.g. error rate > 2% for 5 min>",
              "Rollback Path: <exact steps, e.g. revert this PR, or set flag X=off>",
              "Owner: <who acts on the trigger>",
              FENCE,
            ].join("\n"),
          };
        default:
          return {
            why: "The model could not confidently size the blast radius of this change.",
            fix: "Request a human peer review, or document the decision in an ADR under `docs/decisions/`.",
          };
      }
    },
  };
}

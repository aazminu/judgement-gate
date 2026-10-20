import { describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate";
import { buildRequest, evaluate } from "../src/jev";
import { compileClassifier } from "../src/judgements/classifier";
import { oneWayDoor } from "../src/judgements/one-way-door";
import type { JevAnswers, PrContext } from "../src/types";

const pr: PrContext = { title: "t", body: "", baseBranch: "main", headSha: "abc", files: [{ filename: "services/a.ts", status: "modified" }], patchExtract: "" };

const severity = () =>
  compileClassifier({
    id: "severity",
    name: "Severity",
    question: "If this change is wrong, how bad is the impact?",
    levels: [
      { id: "P0", means: "outage or data loss" },
      { id: "P1", means: "major feature broken" },
      { id: "P3", means: "cosmetic" },
    ],
    appliesTo: ["services/**"],
  });

describe("classifier judgement", () => {
  const j = severity();

  it("asks one choice question whose criteria are level -> means, in order", () => {
    expect(j.id).toBe("severity");
    expect(j.kind).toBe("classifier");
    expect(j.appliesTo).toEqual(["services/**"]);
    expect(Object.keys(j.questions)).toEqual(["q"]);
    expect(j.questions.q.type).toBe("choice");
    expect(j.questions.q.instructions).toBe("If this change is wrong, how bad is the impact?");
    expect(Object.entries(j.questions.q.criteria)).toEqual([
      ["P0", "outage or data loss"],
      ["P1", "major feature broken"],
      ["P3", "cosmetic"],
    ]);
    expect(j.reasons).toEqual(["severity_classified", "severity_unreported"]);
  });

  it("reports the level and confidence, succeeds, and never fires", () => {
    const v = j.decide({ q: { choice: "P1", confidence: 0.82 } }, pr);
    expect(v).toMatchObject({
      conclusion: "success",
      fired: false,
      reason: "severity_classified",
      summary: "Severity: P1",
      classification: { level: "P1", confidence: 0.82 },
    });
    expect(v.metrics?.confidence).toBe(0.82);
  });

  it("matches the level ignoring case and whitespace, returning the configured spelling", () => {
    expect(j.decide({ q: { choice: " p0 " } }, pr).classification).toEqual({ level: "P0" });
  });

  it("omits confidence when the model gave none", () => {
    expect(j.decide({ q: { choice: "P3" } }, pr).classification).toEqual({ level: "P3" });
  });

  it.each([
    ["a level that is not configured", { q: { choice: "P9" } } as JevAnswers],
    ["an empty answer", { q: {} } as JevAnswers],
    ["no answer at all", {} as JevAnswers],
  ])("%s means no level reported, still success", (_n, answers) => {
    const v = j.decide(answers, pr);
    expect(v).toMatchObject({ conclusion: "success", fired: false, reason: "severity_unreported", summary: "Severity: no level reported" });
    expect(v.classification).toBeUndefined();
  });

  it("a successful classifier does not change aggregate()", () => {
    const v = j.decide({ q: { choice: "P0" } }, pr);
    expect(aggregate([{ judgement: j, verdict: v }])).toEqual({ conclusion: "success", reason: "severity_classified", summary: "Severity: P0" });
  });
});

describe("Jev request and answer handling", () => {
  const answersFor = (extra: Record<string, unknown>) => ({
    "severity.q": { choice: "P0", confidence: 0.9 },
    is_one_way_boundary_mutation: { noul: 0.1 },
    is_additive_or_isolated: { noul: 0.9 },
    has_concrete_reversal_plan: { noul: 0.9 },
    synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.9 },
    ...extra,
  });
  const cfg = { apiKey: "k", url: "https://jev.test", model: "m", timeoutMs: 1000 };
  const run = (answers: Record<string, unknown>) =>
    evaluate(pr, [oneWayDoor(), severity()], cfg, (async () => new Response(JSON.stringify({ answers }))) as typeof fetch);

  it("sends the question under the namespaced key in the same request", () => {
    const req = buildRequest(pr, "m", [oneWayDoor(), severity()]);
    expect(Object.keys(req.questions)).toContain("severity.q");
    expect(Object.keys(req.questions)).toContain("synthetic_classification");
  });

  it("passes a good severity answer through", async () => {
    const out = await run(answersFor({}));
    expect(out.severity.q.choice).toBe("P0");
  });

  it.each([
    ["missing", { "severity.q": undefined }],
    ["an empty choice", { "severity.q": { choice: "" } }],
    ["a non-string choice", { "severity.q": { choice: 3 } }],
    ["a non-numeric confidence", { "severity.q": { choice: "P0", confidence: "high" } }],
  ])("a %s severity answer is left out and does not fail the request", async (_n, extra) => {
    const out = await run(answersFor(extra));
    expect(out.severity.q).toBeUndefined();
    expect(out["one-way-door"].is_one_way_boundary_mutation.noul).toBe(0.1);
    expect(severity().decide(out.severity, pr).reason).toBe("severity_unreported");
  });

  it("a missing one-way-door answer still fails the request", async () => {
    await expect(run(answersFor({ is_additive_or_isolated: undefined }))).rejects.toThrow(/missing expected answers/);
  });
});

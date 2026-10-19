import { describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate";
import { renderComment } from "../src/comment";
import { buildRequest, evaluate } from "../src/jev";
import type { Judgement, JudgementVerdict, PrContext } from "../src/types";

const pr: PrContext = { title: "t", body: "b", baseBranch: "main", headSha: "abc", files: [], patchExtract: "" };

const stub = (id: string, name = id): Judgement => ({
  id,
  name,
  questions: { q: { type: "noul", instructions: `ask ${id}`, criteria: { true: "y", false: "n" } } },
  decide: () => ({ conclusion: "success", reason: `${id}_ok`, summary: `${name} ok` }),
  remedy: () => ({ why: `why ${id}`, fix: `fix ${id}` }),
});

const cfg = { apiKey: "k", url: "https://jev.test/d", model: "m", timeoutMs: 1000 };
const jevReturning = (answers: unknown) =>
  (async () => new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch;

describe("jev request", () => {
  it("namespaces question keys by judgement id", () => {
    const req = buildRequest(pr, "m", [stub("a"), stub("b")]);
    expect(Object.keys(req.questions)).toEqual(["a.q", "b.q"]);
    expect(req.questions["a.q"].instructions).toBe("ask a");
  });

  it("returns answers per judgement with the namespace stripped", async () => {
    const out = await evaluate(pr, [stub("a"), stub("b")], cfg, jevReturning({ "a.q": { noul: 0.2 }, "b.q": { noul: 0.9 } }));
    expect(out).toEqual({ a: { q: { noul: 0.2 } }, b: { q: { noul: 0.9 } } });
  });

  it("rejects when an asked question has no answer", async () => {
    await expect(evaluate(pr, [stub("a"), stub("b")], cfg, jevReturning({ "a.q": { noul: 0.2 } }))).rejects.toThrow(
      "missing expected answers",
    );
  });
});

const fail = (j: Judgement): { judgement: Judgement; verdict: JudgementVerdict } => ({
  judgement: j,
  verdict: { conclusion: "failure", reason: `${j.id}_bad`, summary: `${j.name} bad`, signals: "sig" },
});
const pass = (j: Judgement) => ({ judgement: j, verdict: j.decide({}, pr) });
const rc = { owner: "o", repo: "r", headRef: "abc" };

describe("renderComment", () => {
  it("one failure: marker, summary heading, why and fix", () => {
    const md = renderComment([fail(stub("a", "Alpha"))], rc);
    expect(md.startsWith("<!-- judgement-gate -->")).toBe(true);
    expect(md).toContain("### judgement-gate: Alpha bad");
    expect(md).toContain("**Why:** why a");
    expect(md).toContain("**Fix:**");
    expect(md).toContain("fix a");
  });
  it("two failures: count heading and a section per judgement", () => {
    const md = renderComment([fail(stub("a", "Alpha")), fail(stub("b", "Beta"))], rc);
    expect(md).toContain("2 judgements need attention");
    expect(md).toContain("#### Alpha");
    expect(md).toContain("#### Beta");
  });
});

describe("aggregate", () => {
  it("empty list passes with no_applicable", () => {
    expect(aggregate([])).toEqual({ conclusion: "success", reason: "no_applicable", summary: "No applicable judgements" });
  });
  it("any failure fails with the first failing reason", () => {
    const v = aggregate([pass(stub("a")), fail(stub("b")), fail(stub("c"))]);
    expect(v.conclusion).toBe("failure");
    expect(v.reason).toBe("b_bad");
  });
  it("all pass succeeds", () => {
    expect(aggregate([pass(stub("a")), pass(stub("b"))]).conclusion).toBe("success");
  });
});

describe("jev answer validation", () => {
  it("rejects a noul outside 0..1", async () => {
    await expect(evaluate(pr, [stub("a")], cfg, jevReturning({ "a.q": { noul: 1.5 } }))).rejects.toThrow("missing expected answers");
  });
  it("rejects a non-numeric confidence on a choice answer", async () => {
    const choice: Judgement = {
      ...stub("c"),
      questions: { k: { type: "choice", instructions: "pick", criteria: { A: "a", B: "b" } } },
    };
    await expect(evaluate(pr, [choice], cfg, jevReturning({ "c.k": { choice: "A", confidence: "high" } }))).rejects.toThrow(
      "missing expected answers",
    );
  });
});

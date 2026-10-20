import { describe, expect, it } from "vitest";
import { renderComment } from "../src/comment";
import { COMMENT_MARKER } from "../src/github";
import { compileDeclarative } from "../src/judgements/declarative";
import { compileClassifier } from "../src/judgements/classifier";
import { oneWayDoor } from "../src/judgements/one-way-door";
import type { Judgement, JudgementVerdict } from "../src/types";

const rc = { owner: "o", repo: "r", headRef: "abc" };

/** What an agent does: find the block, parse its JSON. */
function parseBlock(md: string) {
  const m = md.match(/<!-- judgement-gate:v(\d+) (\{.*\}) -->/);
  expect(m).not.toBeNull();
  return { version: Number(m![1]), data: JSON.parse(m![2]) };
}

const failing = (judgement: Judgement, verdict: JudgementVerdict) => [{ judgement, verdict }];

describe("agent block", () => {
  it("one-way-door Type 1: ADR glob, still has marker, hint and human text", () => {
    const md = renderComment(
      failing(oneWayDoor(), { conclusion: "failure", reason: "type1_no_adr", summary: "s", fired: true, metrics: { probability: 0.9 } }),
      rc,
      "enforce",
    );
    const { version, data } = parseBlock(md);
    expect(version).toBe(1);
    expect(data.schema).toBe(1);
    expect(data.mode).toBe("enforce");
    const f = data.failing[0];
    expect(f).toMatchObject({ id: "one-way-door", reason: "type1_no_adr", probability: 0.9 });
    expect(f.satisfied_by).toEqual([{ type: "file_added", glob: "docs/decisions/*.md", example_path: "docs/decisions/0001-title.md" }]);
    expect(f.suggested_template.target).toBe("file");
    expect(f.suggested_template.content).toContain("## Decision");
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("**Why:**");
    expect(md).toContain("/judgement-gate false-positive one-way-door");
  });

  it("one-way-door Type 2: required PR body fields and a pasteable template", () => {
    const { data } = parseBlock(renderComment(failing(oneWayDoor(), { conclusion: "failure", reason: "type2_no_plan", summary: "s", fired: false }), rc));
    expect(data.mode).toBe("shadow");
    const f = data.failing[0];
    expect(f.satisfied_by[0]).toMatchObject({ type: "pr_body_fields", fields: ["Reversal Trigger", "Rollback Path"] });
    expect(f.suggested_template.target).toBe("pr_body");
    expect(f.suggested_template.content).toMatch(/^Reversal Trigger:/);
    expect(f.suggested_template.content).toContain("Rollback Path:");
  });

  it("declarative: regex, flags, glob and threshold", () => {
    const j = compileDeclarative({
      id: "api",
      name: "API <change>",
      question: "q",
      whenTrue: "t",
      whenFalse: "f",
      threshold: 0.6,
      satisfiedBy: [{ pr_body_matches: /^Migration Plan:/im }, { file_added: "docs/migrations/**" }],
      why: "w",
      fix: "f",
    });
    const verdict = j.decide({ q: { noul: 0.8 } }, { title: "", body: "", baseBranch: "main", headSha: "x", files: [], patchExtract: "" });
    const md = renderComment(failing(j, verdict), rc);
    const { data } = parseBlock(md);
    const f = data.failing[0];
    expect(f).toMatchObject({ id: "api", name: "API <change>", reason: "api_unsatisfied", probability: 0.8, threshold: 0.6 });
    expect(f.satisfied_by).toEqual([
      { type: "pr_body_matches", regex: "^Migration Plan:", flags: "im" },
      { type: "file_added", glob: "docs/migrations/**" },
    ]);
    expect(f.suggested_template).toBeNull();
  });

  it("reports routing in the block when given, leaving schema at 1", () => {
    const routing = { route: "human" as const, reasons: ["one-way-door flagged"], label: "needs-human-review" };
    const { version, data } = parseBlock(
      renderComment(failing(oneWayDoor(), { conclusion: "failure", reason: "type1_no_adr", summary: "s", fired: true }), rc, "enforce", routing),
    );
    expect(version).toBe(1);
    expect(data.schema).toBe(1);
    expect(data.routing).toEqual(routing);
  });

  it("omits the routing key entirely when no routing is given", () => {
    const { data } = parseBlock(
      renderComment(failing(oneWayDoor(), { conclusion: "failure", reason: "type1_no_adr", summary: "s", fired: true }), rc, "enforce"),
    );
    expect(data.schema).toBe(1);
    expect("routing" in data).toBe(false);
  });

  it("cannot be broken out of by hostile text", () => {
    const j = compileDeclarative({
      id: "x", name: "a --> <script>", question: "q", whenTrue: "t", whenFalse: "f", threshold: 0.5,
      satisfiedBy: [{ pr_body_matches: /-->/ }], why: "w", fix: "f",
    });
    const md = renderComment(failing(j, { conclusion: "failure", reason: "x_unsatisfied", summary: "s", fired: true }), rc);
    const block = md.split("\n").find((l) => l.startsWith("<!-- judgement-gate:v1"))!;
    expect(block.indexOf("-->")).toBe(block.length - 3);
    expect(parseBlock(md).data.failing[0].name).toBe("a --> <script>");
  });
});

describe("classification in the comment", () => {
  const sev = compileClassifier({
    id: "severity",
    name: "Severity",
    question: "q",
    levels: [
      { id: "P0", means: "a" },
      { id: "P1", means: "b" },
    ],
  });
  const classified = { judgement: sev, verdict: sev.decide({ q: { choice: "P1", confidence: 0.82 } }, { title: "", body: "", baseBranch: "", headSha: "", files: [], patchExtract: "" }) };
  const unreported = { judgement: sev, verdict: sev.decide({}, { title: "", body: "", baseBranch: "", headSha: "", files: [], patchExtract: "" }) };
  const failure = { judgement: oneWayDoor(), verdict: { conclusion: "failure" as const, reason: "type2_no_plan", summary: "s", fired: false } };

  it("adds a Severity line and a classification array next to a failing judgement", () => {
    const md = renderComment([failure], rc, "enforce", undefined, [classified, failure]);
    expect(md).toContain("**Severity:** P1 (confidence 0.82)");
    const { version, data } = parseBlock(md);
    expect(version).toBe(1);
    expect(data.schema).toBe(1);
    expect(data.classification).toEqual([{ id: "severity", level: "P1", confidence: 0.82 }]);
    expect(data.failing.map((f: { id: string }) => f.id)).toEqual(["one-way-door"]);
  });

  it("the Severity line sits between the heading and the first section", () => {
    const md = renderComment([failure], rc, "shadow", undefined, [classified, failure]);
    expect(md.indexOf("**Severity:**")).toBeGreaterThan(md.indexOf("### judgement-gate:"));
    expect(md.indexOf("**Severity:**")).toBeLessThan(md.indexOf("#### One-way door"));
  });

  it("omits confidence when there is none", () => {
    const noConf = { judgement: sev, verdict: { ...classified.verdict, classification: { level: "P0" } } };
    const md = renderComment([failure], rc, "shadow", undefined, [noConf, failure]);
    expect(md).toContain("**Severity:** P0\n");
    expect(parseBlock(md).data.classification).toEqual([{ id: "severity", level: "P0", confidence: null }]);
  });

  it("an unreported classifier adds nothing", () => {
    const md = renderComment([failure], rc, "shadow", undefined, [unreported, failure]);
    expect(md).not.toContain("Severity");
    expect(parseBlock(md).data).not.toHaveProperty("classification");
  });

  it("without classifiers the block is exactly what it was before", () => {
    const before = renderComment([failure], rc, "shadow");
    expect(renderComment([failure], rc, "shadow", undefined, [failure])).toBe(before);
    expect(parseBlock(before).data).not.toHaveProperty("classification");
  });

  it("a classifier is never listed as failing or given a false-positive hint", () => {
    const md = renderComment([failure], rc, "shadow", undefined, [classified, failure]);
    expect(md).not.toContain("false-positive severity");
    expect(md).not.toContain("#### Severity");
  });
});

import { describe, expect, it } from "vitest";
import { renderComment } from "../src/comment";
import { COMMENT_MARKER } from "../src/github";
import { compileDeclarative } from "../src/judgements/declarative";
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

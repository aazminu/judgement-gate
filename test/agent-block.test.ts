import { describe, expect, it } from "vitest";
import { renderComment } from "../src/comment";
import { COMMENT_MARKER } from "../src/github";
import { compileDeclarative } from "../src/judgements/declarative";
import { DEFAULT_PROBES, oneWayDoor } from "../src/judgements/one-way-door";
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

describe("line separators", () => {
  it("U+2028 and U+2029 are escaped so the documented agent regex still matches", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const j = compileDeclarative({
      id: "x", name: `n${ls}m`, question: "q", whenTrue: "t", whenFalse: "f", threshold: 0.5,
      satisfiedBy: [{ pr_body_matches: /ok/ }], why: "w", fix: "f", probes: [`Why${ps}not?`],
    });
    const md = renderComment(failing(j, { conclusion: "failure", reason: "x_unsatisfied", summary: "s", fired: true }), rc);
    const block = md.split("\n").find((l) => l.startsWith("<!-- judgement-gate:v1"))!;
    expect(block).not.toContain(ls);
    expect(block).not.toContain(ps);
    const { data } = parseBlock(md);
    expect(data.failing[0].name).toBe(`n${ls}m`);
    expect(data.failing[0].probes).toEqual([`Why${ps}not?`]);
  });
});

describe("probes", () => {
  const declarative = (id: string, name: string, probes?: string[]) =>
    compileDeclarative({
      id, name, question: "q", whenTrue: "t", whenFalse: "f", threshold: 0.5,
      satisfiedBy: [{ pr_body_matches: /^Plan:/m }], why: "w", fix: "f", probes,
    });
  const fail = (reason: string): JudgementVerdict => ({ conclusion: "failure", reason, summary: "s", fired: true, signals: "Signals: x." });

  it("one-way-door Type 1: questions sit between the Fix and the signals, and ride in the block", () => {
    const md = renderComment(failing(oneWayDoor(), fail("type1_no_adr")), rc);
    expect(md).toContain("**Questions a reviewer will ask:**");
    expect(md).toContain(`- ${DEFAULT_PROBES.type1[0]}`);
    expect(md.indexOf("**Fix:**")).toBeLessThan(md.indexOf("**Questions a reviewer will ask:**"));
    expect(md.indexOf("**Questions a reviewer will ask:**")).toBeLessThan(md.indexOf("<sub>Signals"));
    expect(parseBlock(md).data.failing[0].probes).toEqual(DEFAULT_PROBES.type1);
  });

  it("no probes: no heading in the comment and an empty list in the block", () => {
    const md = renderComment(failing(declarative("api", "API"), fail("api_unsatisfied")), rc);
    expect(md).not.toContain("Questions a reviewer will ask");
    expect(parseBlock(md).data.failing[0].probes).toEqual([]);
  });

  it("hostile probe text cannot close the block and round-trips exactly", () => {
    const hostile = "why --> <script>";
    const md = renderComment(failing(declarative("x", "X", [hostile]), fail("x_unsatisfied")), rc);
    const block = md.split("\n").find((l) => l.startsWith("<!-- judgement-gate:v1"))!;
    expect(block.indexOf("-->")).toBe(block.length - 3);
    expect(parseBlock(md).data.failing[0].probes[0]).toBe(hostile);
  });

  it("two failing judgements: each keeps its own questions under its own heading", () => {
    const md = renderComment(
      [
        { judgement: oneWayDoor(), verdict: fail("type1_no_adr") },
        { judgement: declarative("api", "API contract", ["Who consumes this endpoint?"]), verdict: fail("api_unsatisfied") },
      ],
      rc,
    );
    const owd = md.indexOf("#### ");
    const api = md.indexOf("#### API contract");
    const owdProbe = md.indexOf(`- ${DEFAULT_PROBES.type1[0]}`);
    const apiProbe = md.indexOf("- Who consumes this endpoint?");
    expect(owd).toBeLessThan(owdProbe);
    expect(owdProbe).toBeLessThan(api);
    expect(api).toBeLessThan(apiProbe);
    const { failing: f } = parseBlock(md).data;
    expect(f[0].probes).toEqual(DEFAULT_PROBES.type1);
    expect(f[1].probes).toEqual(["Who consumes this endpoint?"]);
  });
});

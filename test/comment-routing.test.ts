import { describe, expect, it } from "vitest";
import { renderComment, renderRoutingComment } from "../src/comment";
import { COMMENT_MARKER } from "../src/github";
import { DEFAULT_PROBES, oneWayDoor } from "../src/judgements/one-way-door";
import type { RoutingResult } from "../src/routing";
import type { JudgementVerdict } from "../src/types";

const rc = { owner: "o", repo: "r", headRef: "abc" };
const failing = [
  { judgement: oneWayDoor(), verdict: { conclusion: "failure", reason: "type2_no_plan", summary: "s", fired: false } as JudgementVerdict },
];
const render = (routing?: RoutingResult, mode = "enforce", routingMode?: string) => renderComment(failing, rc, mode, routing, [], routingMode);
const line = (md: string) => md.split("\n").find((l) => l.startsWith("**Review routing:**"));
const visible = (md: string) => md.slice(0, md.indexOf("<!-- judgement-gate:v1"));

const human: RoutingResult = { route: "human", reasons: ["one-way-door flagged", "files: lib/*.js"], label: "needs-human-review" };

describe("visible routing line in the comment", () => {
  it("human in enforce mode says a person should review and names the label and the reasons", () => {
    const l = line(render(human))!;
    expect(l).toContain("human review recommended");
    expect(l).toContain("`one-way-door flagged`");
    expect(l).toContain("`needs-human-review`");
    expect(l).not.toContain("shadow");
  });

  it("human in shadow routing mode says it is not applied", () => {
    const l = line(render(human, "enforce", "shadow"))!;
    expect(l).toContain("human review recommended");
    expect(l).toContain("shadow");
    expect(l).not.toContain("adds the");
  });

  it("the routing mode, not the check mode, decides the wording", () => {
    expect(line(render(human, "shadow", "enforce"))).not.toContain("shadow");
    expect(line(render(human, "enforce", "shadow"))).toContain("shadow");
  });

  it("reasons are code-wrapped so globs like ** cannot become markdown", () => {
    const l = line(render({ ...human, reasons: ["files: migrations/**"] }))!;
    expect(l).toContain("`files: migrations/**`");
  });

  it("a backtick in a reason cannot break out of its code span", () => {
    const l = line(render({ ...human, reasons: ["config error: bad `key`"] }))!;
    expect(l).toContain("`config error: bad 'key'`");
  });

  it("agent says no rule requires a human", () => {
    const l = line(render({ route: "agent", reasons: [], label: "needs-human-review" }))!;
    expect(l).toContain("agent");
    expect(l).toContain("no rule requires a human");
  });

  it("unavailable says routing could not be decided and why", () => {
    const l = line(render({ route: "unavailable", reasons: ["audit degraded"], label: "needs-human-review" }))!;
    expect(l).toContain("could not be decided");
    expect(l).toContain("`audit degraded`");
  });

  it("no routing result means no line (callers that predate routing)", () => {
    expect(line(render(undefined))).toBeUndefined();
  });

  it("the line sits above the judgement sections, and the hidden block is unchanged", () => {
    const md = render(human);
    expect(md.indexOf("**Review routing:**")).toBeLessThan(md.indexOf("#### One-way door"));
    expect(visible(md)).toContain("**Review routing:**");
    const block = JSON.parse(/<!-- judgement-gate:v1 (\{.*\}) -->/.exec(md)![1]);
    expect(block.routing).toEqual({ route: "human", reasons: human.reasons, label: "needs-human-review" });
  });
});

describe("routing-only comment (nothing failed, routed to a human)", () => {
  const owd = oneWayDoor();
  const cleared = {
    judgement: owd,
    verdict: { conclusion: "success", reason: "type1_adr", summary: "Type 1 verified with ADR", fired: true, signals: "Signals: x." } as JudgementVerdict,
  };
  const severity = {
    judgement: { id: "severity", name: "Severity" } as any,
    verdict: { conclusion: "success", reason: "p1", summary: "s", fired: false, classification: { level: "P1", confidence: 0.82 } } as JudgementVerdict,
  };
  const quiet = {
    judgement: { id: "other", name: "Other", remedy: () => ({ why: "SHOULD NOT SHOW", fix: "" }), probes: () => ["NOPE?"] } as any,
    verdict: { conclusion: "success", reason: "other_ok", summary: "ok", fired: false } as JudgementVerdict,
  };
  const render = (routing: RoutingResult = human, all = [cleared, quiet, severity], mode = "enforce", routingMode?: string) =>
    renderRoutingComment(routing, rc, mode, routingMode, all);
  const block = (md: string) => JSON.parse(/<!-- judgement-gate:v1 (\{.*\}) -->/.exec(md)![1]);

  it("carries the marker so it edits the same comment, and a heading that says passed and routed to a human", () => {
    const md = render();
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toMatch(/### judgement-gate: passed the checks, routed to a human reviewer/);
  });

  it("shadow routing: heading and line do not claim a routing that did not happen", () => {
    const md = render(human, [cleared], "enforce", "shadow");
    expect(md).toContain("### judgement-gate: passed the checks, human review recommended");
    expect(md).not.toContain("routed to a human reviewer");
    expect(line(md)).toContain("shadow");
    expect(line(md)).not.toContain("adds the");
  });

  it("shows the routing line, the severity line and the reasons", () => {
    const md = render();
    expect(line(md)).toContain("`one-way-door flagged`");
    expect(md).toContain("**Severity:** P1 (confidence 0.82)");
  });

  it("explains a cleared judgement with its why and its probes as questions for the reviewer", () => {
    const md = visible(render());
    expect(md).toContain("#### One-way door");
    expect(md).toContain("The ADR records the reasoning");
    expect(md).toContain("**Questions a reviewer will ask:**");
    expect(md).toContain(`- ${DEFAULT_PROBES.type1[0]}`);
  });

  it("leaves out judgements that did not fire, and says nothing about fixing", () => {
    const md = visible(render());
    expect(md).not.toContain("SHOULD NOT SHOW");
    expect(md).not.toContain("NOPE?");
    expect(md).not.toContain("**Fix:**");
    expect(md).not.toContain("Not a real issue");
  });

  it("a route with no cleared judgement (files rule) has the line and no judgement section", () => {
    const md = visible(render({ ...human, reasons: ["files: migrations/**"] }, [quiet]));
    expect(line(md)).toContain("`files: migrations/**`");
    expect(md).not.toContain("####");
  });

  it("the hidden block has failing [], the routing and the classification, schema 1", () => {
    const b = block(render());
    expect(b.schema).toBe(1);
    expect(b.failing).toEqual([]);
    expect(b.routing).toEqual({ route: "human", reasons: human.reasons, label: "needs-human-review" });
    expect(b.classification).toEqual([{ id: "severity", level: "P1", confidence: 0.82 }]);
  });

  it("no classifier: no classification key", () => {
    expect(block(render(human, [cleared])).classification).toBeUndefined();
  });
});

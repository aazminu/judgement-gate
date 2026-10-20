import { describe, expect, it } from "vitest";
import { renderComment } from "../src/comment";
import { oneWayDoor } from "../src/judgements/one-way-door";
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

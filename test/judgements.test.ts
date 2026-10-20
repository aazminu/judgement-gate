import { describe, expect, it } from "vitest";
import { appliesToFiles, matchesGlob } from "../src/glob";
import { DEFAULT_PROBES, oneWayDoor } from "../src/judgements/one-way-door";
import type { JevAnswers, PrContext } from "../src/types";

describe("glob", () => {
  it("matches ** across directories", () => {
    expect(matchesGlob("services/api/**", "services/api/v1/x.ts")).toBe(true);
    expect(matchesGlob("services/api/**", "services/web/x.ts")).toBe(false);
  });
  it("* does not cross directories", () => {
    expect(matchesGlob("docs/api-changes/*.md", "docs/api-changes/a.md")).toBe(true);
    expect(matchesGlob("docs/*.md", "docs/a/b.md")).toBe(false);
  });
  it("**/ matches zero or more directories", () => {
    expect(matchesGlob("**/*.sql", "a/b/c.sql")).toBe(true);
    expect(matchesGlob("**/*.sql", "c.sql")).toBe(true);
  });
  it("? matches one non-slash char", () => {
    expect(matchesGlob("a?c", "abc")).toBe(true);
    expect(matchesGlob("a?c", "a/c")).toBe(false);
  });
  it("appliesToFiles: undefined means always, otherwise any match", () => {
    expect(appliesToFiles(undefined, [])).toBe(true);
    expect(appliesToFiles(["x/**"], [{ filename: "y.ts", status: "added" }])).toBe(false);
    expect(appliesToFiles(["x/**"], [{ filename: "x/y.ts", status: "added" }])).toBe(true);
  });
});

const pr = (files: PrContext["files"] = [{ filename: "src/a.ts", status: "modified" }]): PrContext => ({
  title: "t",
  body: "",
  baseBranch: "main",
  headSha: "abc",
  files,
  patchExtract: "",
});

function answers(o: { one: number; add: number; rev: number; cls: string; conf: number }): JevAnswers {
  return {
    is_one_way_boundary_mutation: { noul: o.one },
    is_additive_or_isolated: { noul: o.add },
    has_concrete_reversal_plan: { noul: o.rev },
    synthetic_classification: { choice: o.cls, confidence: o.conf },
  };
}
const type1 = answers({ one: 0.96, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 });
const type2 = answers({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 });

describe("one-way-door judgement", () => {
  const j = oneWayDoor();
  it("has a stable id and the four questions", () => {
    expect(j.id).toBe("one-way-door");
    expect(Object.keys(j.questions)).toEqual([
      "is_one_way_boundary_mutation",
      "is_additive_or_isolated",
      "has_concrete_reversal_plan",
      "synthetic_classification",
    ]);
  });
  it("type1 without ADR fails; with ADR passes", () => {
    const f = j.decide(type1, pr());
    expect(f.conclusion).toBe("failure");
    expect(f.reason).toBe("type1_no_adr");
    const ok = j.decide(type1, pr([{ filename: "docs/decisions/0001-x.md", status: "added" }]));
    expect(ok.conclusion).toBe("success");
    expect(ok.reason).toBe("type1_adr");
  });
  it("type2 with plan passes", () => {
    expect(j.decide(type2, pr()).reason).toBe("type2_ok");
  });
  it("low confidence is ambiguous, and the threshold is overridable", () => {
    const low = answers({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.5 });
    expect(j.decide(low, pr()).reason).toBe("ambiguous");
    expect(oneWayDoor({ confidenceThreshold: 0.4 }).decide(low, pr()).reason).toBe("type2_ok");
  });
  it("remedy teaches why and says what to do", () => {
    const rc = { owner: "o", repo: "r", headRef: "abc" };
    const r1 = j.remedy(j.decide(type1, pr()), rc);
    expect(r1.why).toContain("one-way door");
    expect(r1.fix).toContain("docs/decisions/");
    expect(r1.fix).toContain("https://github.com/o/r/new/abc");
    const noPlan = answers({ one: 0.02, add: 0.9, rev: 0.3, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 });
    const r2 = j.remedy(j.decide(noPlan, pr()), rc);
    expect(r2.fix).toContain("Reversal Trigger:");
    expect(r2.fix).toContain("Rollback Path:");
  });
  it("carries appliesTo", () => {
    expect(oneWayDoor({ appliesTo: ["db/**"] }).appliesTo).toEqual(["db/**"]);
  });
});

describe("one-way-door probes", () => {
  const j = oneWayDoor();
  const noPlan = answers({ one: 0.02, add: 0.9, rev: 0.3, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 });
  it("type1_no_adr gets the type 1 probes", () => {
    const v = j.decide(type1, pr());
    expect(v.reason).toBe("type1_no_adr");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type1);
    expect(DEFAULT_PROBES.type1).toHaveLength(5);
  });
  it("type2_no_plan gets the type 2 probes", () => {
    const v = j.decide(noPlan, pr());
    expect(v.reason).toBe("type2_no_plan");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type2);
    expect(DEFAULT_PROBES.type2).toHaveLength(3);
  });
  it("ambiguous gets the type 1 probes", () => {
    const low = answers({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.5 });
    const v = j.decide(low, pr());
    expect(v.reason).toBe("ambiguous");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type1);
  });
  it("a passing verdict has no probes", () => {
    expect(j.probes!(j.decide(type2, pr()))).toEqual([]);
  });
  it("options override one list and keep the other default", () => {
    const custom = oneWayDoor({ probes: { type2: ["Custom?"] } });
    expect(custom.probes!(custom.decide(noPlan, pr()))).toEqual(["Custom?"]);
    expect(custom.probes!(custom.decide(type1, pr()))).toEqual(DEFAULT_PROBES.type1);
  });
});

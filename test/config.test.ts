import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config";
import type { JevAnswers, PrContext } from "../src/types";

const defaults = { confidenceThreshold: 0.75 };

const SPEC_EXAMPLE = `
judgements:
  - use: one-way-door
    confidence_threshold: 0.5

  - id: public-api-contract
    name: Public API contract change
    question: "Does this change break or remove a public API contract?"
    true: "removes/renames endpoints, fields or exported symbols"
    false: "additive or internal only"
    threshold: 0.6
    applies_to: ["services/api/**"]
    satisfied_by:
      - pr_body_matches: "(?i)^Migration Plan:"
      - file_added: "docs/api-changes/*.md"
    why: "Consumers cannot roll back with us. Breaking changes need a plan."
    fix: "Add a 'Migration Plan:' line to the PR description."
`;

const pr = (body = "", files: PrContext["files"] = []): PrContext => ({
  title: "t",
  body,
  baseBranch: "main",
  headSha: "abc",
  files,
  patchExtract: "",
});
const q = (noul: number): JevAnswers => ({ q: { noul } });

function api() {
  const list = parseConfig(SPEC_EXAMPLE, defaults);
  return list.find((j) => j.id === "public-api-contract")!;
}

describe("parseConfig: valid", () => {
  it("builds built-in and declarative judgements from the spec example", () => {
    const list = parseConfig(SPEC_EXAMPLE, defaults);
    expect(list.map((j) => j.id)).toEqual(["one-way-door", "public-api-contract"]);
    expect(api().name).toBe("Public API contract change");
    expect(api().appliesTo).toEqual(["services/api/**"]);
  });

  it("applies confidence_threshold override to the built-in", () => {
    const owd = parseConfig(SPEC_EXAMPLE, defaults)[0];
    const a: JevAnswers = {
      is_one_way_boundary_mutation: { noul: 0.02 },
      is_additive_or_isolated: { noul: 0.9 },
      has_concrete_reversal_plan: { noul: 0.9 },
      synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.6 },
    };
    expect(owd.decide(a, pr()).reason).toBe("type2_ok"); // 0.6 >= overridden 0.5
  });

  it("applies applies_to override to the built-in", () => {
    const owd = parseConfig("judgements:\n  - use: one-way-door\n    applies_to: ['db/**']", defaults)[0];
    expect(owd.appliesTo).toEqual(["db/**"]);
  });

  it.each(["", "# comment only", "judgements: []", "other: 1"])("falls back to default built-in for %j", (text) => {
    const list = parseConfig(text, defaults);
    expect(list.map((j) => j.id)).toEqual(["one-way-door"]);
  });
});

describe("declarative decide", () => {
  it("flagged and unsatisfied fails", () => {
    const v = api().decide(q(0.7), pr("nope"));
    expect(v.conclusion).toBe("failure");
    expect(v.reason).toBe("public-api-contract_unsatisfied");
    expect(v.summary).toBe("Public API contract change: not satisfied");
  });
  it("flagged and satisfied by body passes, case-insensitively", () => {
    expect(api().decide(q(0.7), pr("Migration Plan: x")).reason).toBe("public-api-contract_ok");
    expect(api().decide(q(0.7), pr("migration plan: x")).conclusion).toBe("success");
  });
  it("body pattern matches at the start of any line", () => {
    expect(api().decide(q(0.7), pr("Intro\n\nMigration Plan: x")).conclusion).toBe("success");
  });
  it("below threshold passes, exactly at threshold is flagged", () => {
    expect(api().decide(q(0.59), pr("nope")).conclusion).toBe("success");
    expect(api().decide(q(0.6), pr("nope")).conclusion).toBe("failure");
  });
  it("file_added is satisfied by added files but not removed ones", () => {
    const added = [{ filename: "docs/api-changes/a.md", status: "added" }];
    const removed = [{ filename: "docs/api-changes/a.md", status: "removed" }];
    expect(api().decide(q(0.9), pr("nope", added)).conclusion).toBe("success");
    expect(api().decide(q(0.9), pr("nope", removed)).conclusion).toBe("failure");
  });
  it("remedy returns the YAML why and fix", () => {
    const j = api();
    const r = j.remedy(j.decide(q(0.9), pr("nope")), { owner: "o", repo: "r", headRef: "abc" });
    expect(r.why).toBe("Consumers cannot roll back with us. Breaking changes need a plan.");
    expect(r.fix).toBe("Add a 'Migration Plan:' line to the PR description.");
  });
  it("signals show probability and threshold", () => {
    expect(api().decide(q(0.7), pr("nope")).signals).toContain("70%");
    expect(api().decide(q(0.7), pr("nope")).signals).toContain("60%");
  });
  it("asks one noul question with true/false criteria", () => {
    const question = api().questions.q;
    expect(question.type).toBe("noul");
    expect(question.criteria.true).toContain("removes/renames");
    expect(question.criteria.false).toBe("additive or internal only");
  });
});

const decl = (extra: Record<string, unknown> = {}, drop: string[] = []) => {
  const base: Record<string, unknown> = {
    id: "x",
    name: "X",
    question: "Q?",
    true: "t",
    false: "f",
    threshold: 0.5,
    satisfied_by: [{ pr_body_matches: "ok" }],
    why: "w",
    fix: "f",
    ...extra,
  };
  for (const k of drop) delete base[k];
  return JSON.stringify({ judgements: [base] });
};

describe("parseConfig: invalid throws ConfigError", () => {
  const cases: [string, string][] = [
    ["yaml syntax error", "judgements: ["],
    ["judgements not a list", "judgements: {}"],
    ["unknown use", "judgements:\n  - use: nope"],
    ["disallowed override on use", "judgements:\n  - use: one-way-door\n    threshold: 0.5"],
    ["duplicate ids", JSON.stringify({ judgements: [JSON.parse(decl()).judgements[0], JSON.parse(decl()).judgements[0]] })],
    ["threshold above 1", decl({ threshold: 1.5 })],
    ["threshold below 0", decl({ threshold: -0.1 })],
    ["missing satisfied_by", decl({}, ["satisfied_by"])],
    ["empty satisfied_by", decl({ satisfied_by: [] })],
    ["unknown satisfied_by type", decl({ satisfied_by: [{ bogus: 1 }] })],
    ["regex does not compile", decl({ satisfied_by: [{ pr_body_matches: "(" }] })],
    ["regex too long", decl({ satisfied_by: [{ pr_body_matches: "a".repeat(201) }] })],
    ["missing question", decl({}, ["question"])],
    ["missing why", decl({}, ["why"])],
    ["non-string fix", decl({ fix: 5 })],
    ["id collides with built-in", decl({ id: "one-way-door" })],
  ];
  it.each(cases)("%s", (_name, text) => {
    expect(() => parseConfig(text, defaults)).toThrow(ConfigError);
  });

  it("names the offending judgement in the message", () => {
    expect(() => parseConfig(decl({ threshold: 2 }), defaults)).toThrow(/x.*threshold/);
  });
});

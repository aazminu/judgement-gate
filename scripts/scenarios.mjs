// Demo PR scenarios shared by the mock GitHub server, the webhook simulator and the e2e harness (scripts/e2e.mjs).
// `jev` is read only by the e2e harness: the answers the scripted Jev stub gives for this PR, keyed by Jev question
// key. A question the scenario does not answer is left out of the stub's response, so it shows up as a degraded audit.
const noul = (p) => ({ noul: p });
const choice = (value, confidence = 0.95) => ({ choice: value, confidence });
const TYPE1 = {
  is_one_way_boundary_mutation: noul(0.95),
  is_additive_or_isolated: noul(0.05),
  has_concrete_reversal_plan: noul(0.05),
  synthetic_classification: choice("TYPE_1_ONE_WAY_DOOR"),
};
const TYPE2_PLAN = {
  is_one_way_boundary_mutation: noul(0.05),
  is_additive_or_isolated: noul(0.9),
  has_concrete_reversal_plan: noul(0.95),
  synthetic_classification: choice("TYPE_2_TWO_WAY_DOOR"),
};
const TYPE2_NO_PLAN = { ...TYPE2_PLAN, has_concrete_reversal_plan: noul(0.05) };

const PLAN = "Reversal Trigger: error rate > 2% for 5 min.\nRollback Path: set flag NEW_SEARCH=off or revert this PR.";
export const SCENARIOS = {
  1: {
    title: "Drop legacy users.email column",
    body: "Cleanup.",
    files: [{ filename: "migrations/0042_drop_email.sql", status: "added", patch: "@@\n+ALTER TABLE users DROP COLUMN email;" }],
    jev: TYPE1,
  },
  2: {
    title: "Drop legacy users.email column (with ADR)",
    body: "Cleanup. See ADR.",
    files: [
      { filename: "migrations/0042_drop_email.sql", status: "added", patch: "@@\n+ALTER TABLE users DROP COLUMN email;" },
      { filename: "docs/decisions/0042-drop-email.md", status: "added", patch: "@@\n+# Drop email\n+Decision: ..." },
    ],
    jev: TYPE1,
  },
  3: {
    title: "Add behind-a-flag search suggestions",
    body: "Adds suggestions UI.\n\n" + PLAN,
    files: [{ filename: "src/search/suggest.ts", status: "added", patch: "@@\n+if (flags.NEW_SEARCH) renderSuggestions();" }],
    jev: TYPE2_PLAN,
  },
  4: {
    title: "Add behind-a-flag search suggestions",
    body: "Adds suggestions UI.",
    files: [{ filename: "src/search/suggest.ts", status: "added", patch: "@@\n+if (flags.NEW_SEARCH) renderSuggestions();" }],
    jev: TYPE2_NO_PLAN,
  },
  // 5 and 6 need the example org config (examples/judgement-gate.yml), which the mock serves by default.
  5: {
    title: "Rename user.name to user.fullName in the API",
    body: "Cleaner naming.",
    files: [{ filename: "services/api/v1/users.ts", status: "modified", patch: "@@\n-  name: string;\n+  fullName: string;" }],
    jev: { ...TYPE2_PLAN, "public-api-contract.q": noul(0.9), "severity.q": choice("P2", 0.8) },
  },
  6: {
    title: "Rename user.name to user.fullName in the API (with plan)",
    body: "Cleaner naming.\n\nMigration Plan: serve both fields for one release, then remove name.",
    files: [{ filename: "services/api/v1/users.ts", status: "modified", patch: "@@\n-  name: string;\n+  fullName: string;" }],
    jev: { ...TYPE2_PLAN, "public-api-contract.q": noul(0.9), "severity.q": choice("P2", 0.8) },
  },
  // Severity (examples/judgement-gate.yml) is a classifier: it labels the PR and never fails the check.
  // It applies to anything under services/**, so 5 and 6 show a Severity line too. 7 is a reversible change to a sensitive path.
  7: {
    title: "Retry failed card charges once in checkout",
    body: "Retries a declined charge once.\n\n" + PLAN,
    files: [
      {
        filename: "services/checkout/charge.ts",
        status: "modified",
        patch: "@@\n-  return charge(card);\n+  return flags.RETRY_CHARGE ? retryOnce(() => charge(card)) : charge(card);",
      },
    ],
    jev: { ...TYPE2_PLAN, "severity.q": choice("P1", 0.8) },
  },
};
